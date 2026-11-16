// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the chat-run suites share (inner#1717): a signed-in owner with a
 * project and a conversation, the five ways a page talks to a run (send, sync,
 * attach, stop, take back), and reading a conversation's queue keys off Redis.
 *
 * A run is no longer the response to the send that started it: a send answers
 * with its status as JSON, and the run's frames are read by attaching to
 * `GET /chat/conversations/:id/stream`, which a case reads to its end here.
 */
import crypto from "node:crypto";
import type postgres from "postgres";
import type { Hono } from "hono";
import { getRedis, sessionCookieName, setSession } from "@breatic/core";
import { runObservers } from "@server/agent/chat-run.js";
import { runStreams } from "@server/agent/run-stream.js";
import { chatQueueKeys } from "@server/modules/chat-queue/chat-queue.service.js";

/** One signed-in owner and their open conversation. */
export interface Seeded {
  userId: string;
  projectId: string;
  conversationId: string;
  cookie: string;
}

/**
 * Seed a user with a project, sign them in and open a conversation.
 * @param sql - The database.
 * @param app - The server app.
 * @returns The ids and cookie a request needs.
 */
export async function seedOwner(sql: ReturnType<typeof postgres>, app: Hono): Promise<Seeded> {
  const tag = `run-${crypto.randomBytes(4).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  await sql`INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${`${tag}-me`}, 'personal', ${tag})`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${user!.id}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${user!.id}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug) VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (${project!.id}, ${user!.id}, 'owner', null)`;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, user!.id);
  const cookie = `${sessionCookieName()}=${token}`;
  const opened = await app.request("/api/v1/chat/open", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: project!.id }),
  });
  const body = (await opened.json()) as { data: { current: { conversation: { id: string } } } };
  return { userId: user!.id, projectId: project!.id, conversationId: body.data.current.conversation.id, cookie };
}

/** The five keys of a conversation's queue, as the server names them. */
export const keysOf = chatQueueKeys;

/**
 * The ids in one of a conversation's lists.
 * @param key - The list.
 * @returns The ids, in order.
 */
export async function listIds(key: string): Promise<string[]> {
  return (await getRedis().lrange(key, 0, -1)).map((raw) => (JSON.parse(raw) as { id: string }).id);
}

/** What a page sends, minus what the case leaves at its default. */
export type SendBody = Record<string, unknown> & { id?: string; message?: string };

/**
 * Send a message.
 * @param app - The server app.
 * @param who - Whose conversation.
 * @param body - What is sent; the conversation and project are filled in.
 * @param headers - Extra headers.
 * @returns The response.
 */
export async function send(app: Hono, who: Seeded, body: SendBody = {}, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { Cookie: who.cookie, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      id: crypto.randomUUID(),
      message: "hello",
      project_id: who.projectId,
      conversation_id: who.conversationId,
      ...body,
    }),
  });
}

/**
 * Ask the server where the conversation stands, opening a run when work waits.
 * @param app - The server app.
 * @param who - Whose conversation.
 * @returns The response.
 */
export async function sync(app: Hono, who: Seeded): Promise<Response> {
  return app.request(`/api/v1/chat/conversations/${who.conversationId}/sync`, {
    method: "POST",
    headers: { Cookie: who.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: who.projectId }),
  });
}

/**
 * Press stop.
 * @param app - The server app.
 * @param who - Whose conversation.
 * @returns The response.
 */
export async function stop(app: Hono, who: Seeded): Promise<Response> {
  return app.request("/api/v1/chat/stop", {
    method: "POST",
    headers: { Cookie: who.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: who.conversationId, project_id: who.projectId }),
  });
}

/**
 * Take a waiting message back.
 * @param app - The server app.
 * @param who - Whose conversation.
 * @param messageId - Which message.
 * @returns The response.
 */
export async function takeBack(app: Hono, who: Seeded, messageId: string): Promise<Response> {
  return app.request(`/api/v1/chat/conversations/${who.conversationId}/queue/${messageId}`, {
    method: "DELETE",
    headers: { Cookie: who.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: who.projectId }),
  });
}

/**
 * Attach to the conversation's run and read every frame until it ends.
 * @param app - The server app.
 * @param who - Whose conversation.
 * @returns The status, and each frame's chunk when there was a stream.
 */
export async function attach(app: Hono, who: Seeded): Promise<{ status: number; frames: Record<string, unknown>[] }> {
  const res = await app.request(`/api/v1/chat/conversations/${who.conversationId}/stream`, {
    headers: { Cookie: who.cookie },
  });
  if (res.status !== 200) return { status: res.status, frames: [] };
  const text = await res.text();
  const frames = text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
  return { status: 200, frames };
}

/**
 * Wait until a check holds.
 * @param check - What must become true.
 * @param ms - How long to wait at most.
 * @throws {Error} When it never does.
 */
export async function until(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition never held");
}

/**
 * Wait until the conversation has no run.
 * @param c - The conversation.
 */
export async function untilIdle(c: string): Promise<void> {
  await until(async () => (await getRedis().exists(keysOf(c).active)) === 0);
}

/** What a send answered, and every frame of the run it opened. */
export interface SentAndRead {
  status: number;
  /** The JSON body; for a refusal, the error envelope. */
  json: Record<string, unknown> | null;
  /** Each frame of the run the send opened or joined, in order; empty when it opened none. */
  chunks: Record<string, unknown>[];
}

/**
 * Send to `POST /chat/message` and read the run it opens, the way a page now
 * does: the send answers as JSON, and the run's frames come from its stream
 * (inner#1717). A new message is given an id when the case gave none. The run
 * is attached to as soon as its stream exists, so every frame is read however
 * fast the run is; the call returns once the run has ended.
 * @param app - The server app.
 * @param cookie - The signed-in session.
 * @param body - What is sent.
 * @param headers - Extra headers.
 * @returns The answer and the run's frames.
 */
export async function sendAndRead(
  app: Hono,
  cookie: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<SentAndRead> {
  const conversationId = String(body.conversation_id ?? "");
  const isCard = body.answer !== undefined || body.shared_spaces !== undefined;
  const sent = isCard || body.id !== undefined ? body : { id: crypto.randomUUID(), ...body };
  let reading: Promise<Record<string, unknown>[]> | undefined;
  const observe = async (run: { conversationId: string; runId: string }): Promise<void> => {
    if (run.conversationId !== conversationId || reading !== undefined) return;
    // Held at once, since the send can answer before the attach resolves; the
    // run waits only for the attach, never for the frames it has yet to write.
    const attached = runStreams().resumeExistingStream(run.runId);
    reading = attached.then((stream) => (stream ? framesOfText(stream) : []));
    await attached.catch(() => undefined);
  };
  runObservers.push(observe);
  try {
    const res = await app.request("/api/v1/chat/message", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
      body: JSON.stringify(sent),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    const chunks = reading === undefined ? [] : await reading;
    if (conversationId !== "") await untilIdle(conversationId);
    return { status: res.status, json, chunks };
  } finally {
    runObservers.splice(runObservers.indexOf(observe), 1);
  }
}

/**
 * Read a run's stream of SSE text to its end and parse its frames.
 * @param stream - The stream.
 * @returns Each frame's chunk, in order.
 */
async function framesOfText(stream: ReadableStream<string>): Promise<Record<string, unknown>[]> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += value;
  }
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);
}

/**
 * The frames a turn said, without the ones the run's stream writes itself:
 * its beats and the frame naming its run.
 * @param frames - Every frame read.
 * @returns The turn's own frames.
 */
export function turnFrames<F extends { type?: unknown }>(frames: F[]): F[] {
  return frames.filter((f) => f.type !== "data-heartbeat" && f.type !== "data-run");
}
