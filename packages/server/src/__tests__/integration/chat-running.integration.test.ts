// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A running turn is visible to the user's other tabs while it runs (#1394),
 * driven through the real app against real Postgres and Redis.
 *
 * `GET /chat/running` answers the conversations whose turn holds a lease. The
 * lease is taken when the turn's stream opens and released before it closes,
 * however the turn ended -- answered, or the client gone mid-turn. A lease
 * that runs out on its own lasts one heartbeat interval times the misses a
 * browser allows (15 s with the shipped config), so every "gone" asserted
 * here is checked well inside that: what removes it has to be the release.
 *
 * The model is doubled at the model layer and held open behind a gate, so a
 * case can look at the list while a turn is truly in progress.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

const { gate, broken, leaseErrors } = vi.hoisted(() => ({
  /** Opened by a case to let the model finish its answer. */
  gate: { promise: Promise.resolve(), open: (): void => {} },
  /** While set, every Redis command that touches a running-turn key fails. */
  broken: { on: false },
  /** Stands in for `logger.error`, so the lease failure line can be read. */
  leaseErrors: { spy: null as null | ((...args: unknown[]) => void) },
}));

vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { MockLanguageModelV4 } = await import("ai/test");
  const { FINISHED } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => "test",
    // Says its first words at once, then waits for the gate (or the stop)
    // before finishing.
    getModel: () =>
      new MockLanguageModelV4({
        doStream: async (asked) => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({ type: "text-delta", id: "t1", delta: "hi" });
              let done = false;
              const end = (finish: boolean): void => {
                if (done) return;
                done = true;
                if (finish) {
                  controller.enqueue({ type: "text-end", id: "t1" });
                  controller.enqueue(FINISHED);
                }
                controller.close();
              };
              if (asked.abortSignal?.aborted === true) end(false);
              asked.abortSignal?.addEventListener("abort", () => end(false));
              void gate.promise.then(() => end(true));
            },
          }),
        }),
      }),
  };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realGetRedis = actual.getRedis as () => object;
  const realLogger = actual.logger as Record<string | symbol, unknown>;

  /**
   * Whether a command's arguments name a running-turn key.
   * @param args - The command's arguments.
   * @returns True when one of them does.
   */
  const touches = (args: unknown[]): boolean =>
    args.some((a) => typeof a === "string" && a.includes(":chat-running:"));

  /**
   * A batch (`multi` / `pipeline`) whose `exec` fails if it queued a
   * running-turn command, the way a batch fails on a dropped connection.
   * @param batch - The real batch.
   * @returns The wrapped batch.
   */
  const breakingBatch = (batch: object): object => {
    let touched = false;
    const proxy: object = new Proxy(batch, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "exec") {
          return () =>
            touched
              ? Promise.reject(new Error("redis is down for running-turn keys"))
              : (value as () => unknown).call(target);
        }
        return (...args: unknown[]) => {
          if (touches(args)) touched = true;
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out === target ? proxy : out;
        };
      },
    });
    return proxy;
  };

  /**
   * The real client, with every running-turn command failing.
   * @param redis - The real client.
   * @returns The wrapped client.
   */
  const breakingRedis = (redis: object): object =>
    new Proxy(redis, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        if (prop === "multi" || prop === "pipeline") {
          return (...args: unknown[]) => breakingBatch((value as (...a: unknown[]) => object).apply(target, args));
        }
        return (...args: unknown[]) =>
          touches(args)
            ? Promise.reject(new Error("redis is down for running-turn keys"))
            : (value as (...a: unknown[]) => unknown).apply(target, args);
      },
    });

  return {
    ...actual,
    getRedis: () => (broken.on ? breakingRedis(realGetRedis()) : realGetRedis()),
    logger: new Proxy(realLogger, {
      get(target, prop) {
        if (prop === "error" && leaseErrors.spy) return leaseErrors.spy;
        return Reflect.get(target, prop);
      },
    }),
  };
});

import type * as DomainModule from "@breatic/domain";
import crypto from "node:crypto";
import postgres from "postgres";
import { env, getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // Already initialised by a sibling suite in this worker.
}
loadLocales();

const PG_DRIVER_LOCAL = "chat-running-test-driver";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

afterEach(() => {
  // A case that failed before opening its gate would leave a turn hanging.
  gate.open();
  broken.on = false;
  leaseErrors.spy = null;
});

/**
 * Close the gate, so the next turn waits for the case to open it.
 */
function closeGate(): void {
  let open = (): void => {};
  gate.promise = new Promise<void>((r) => {
    open = r;
  });
  gate.open = open;
}

let seq = 0;

/** A signed-in owner of a project, with a conversation open in it. */
interface Seeded {
  userId: string;
  projectId: string;
  conversationId: string;
  cookie: string;
}

/**
 * Give a user a session and the cookie that carries it.
 * @param userId - User to sign in.
 * @returns A Cookie header value `requireAuth` accepts.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

/**
 * Insert a user with no membership anywhere, signed in.
 * @returns The user's id and cookie.
 */
async function seedUser(): Promise<{ userId: string; cookie: string }> {
  const tag = `chat-running-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  return { userId: user!.id, cookie: await loginCookie(user!.id) };
}

/**
 * Seed an owner with a project, signed in, holding a conversation there.
 * @returns The owner, their project, conversation and cookie.
 */
async function seedOwner(): Promise<Seeded> {
  const tag = `chat-running-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const { userId, cookie } = await seedUser();
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`${tag}-studio`}, 'team', ${tag}) RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${userId}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${userId}, 'owner', null)
  `;
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, title, project_id)
    VALUES (${userId}, 'seeded', ${project!.id}) RETURNING id
  `;
  return { userId, projectId: project!.id, conversationId: conversation!.id, cookie };
}

/**
 * Start a turn without reading its stream.
 * @param who - The owner and their conversation.
 * @returns The response, its body unread.
 */
async function startTurn(who: Seeded): Promise<Response> {
  return app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: who.cookie },
    body: JSON.stringify({
      message: "hello",
      project_id: who.projectId,
      conversation_id: who.conversationId,
    }),
  });
}

/**
 * Ask which conversations are running.
 * @param projectId - The project to ask about.
 * @param cookie - Whose session asks.
 * @returns The status and the ids answered.
 */
async function running(projectId: string, cookie: string): Promise<{ status: number; ids: string[] | undefined }> {
  const res = await app.request(`/api/v1/chat/running?project_id=${projectId}`, { headers: { Cookie: cookie } });
  if (res.status !== 200) return { status: res.status, ids: undefined };
  const body = (await res.json()) as { data: { conversation_ids: string[] } };
  return { status: res.status, ids: body.data.conversation_ids };
}

/**
 * Read a stream until a chunk of the named type has arrived.
 * @param reader - The response body's reader.
 * @param type - The chunk type to wait for.
 * @returns Everything read so far.
 * @throws {Error} When the stream ends first.
 */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, type: string): Promise<string> {
  const decoder = new TextDecoder();
  let wire = "";
  while (!wire.includes(`"type":"${type}"`)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before a ${type} chunk; got: ${wire}`);
    wire += decoder.decode(value, { stream: true });
  }
  return wire;
}

/**
 * The chunks on a stream, in arrival order.
 * @param wire - The whole response body.
 * @returns One parsed chunk per `data:` frame.
 */
function frames(wire: string): Array<Record<string, unknown>> {
  return wire
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((body) => body !== "[DONE]")
    .map((body) => JSON.parse(body) as Record<string, unknown>);
}

/**
 * Ask until the list is empty, or give up.
 * @param projectId - The project to ask about.
 * @param cookie - Whose session asks.
 * @param withinMs - How long to keep asking.
 * @returns The last answer.
 */
async function untilNoneRunning(
  projectId: string,
  cookie: string,
  withinMs: number,
): Promise<{ status: number; ids: string[] | undefined }> {
  const deadline = Date.now() + withinMs;
  let last = await running(projectId, cookie);
  while (Date.now() < deadline && !(last.status === 200 && last.ids?.length === 0)) {
    await new Promise((r) => setTimeout(r, 100));
    last = await running(projectId, cookie);
  }
  return last;
}

describe("GET /chat/running", () => {
  it("answers the caller's running conversations and nothing to another user asking about the same project", async () => {
    const owner = await seedOwner();
    const stranger = await seedUser();
    // A lease planted where the owner's turn would hold it, live for a minute.
    await getRedis().zadd(
      `${env.REDIS_KEY_PREFIX}:server:chat-running:${owner.userId}:${owner.projectId}`,
      Date.now() + 60_000,
      `${owner.conversationId}:${crypto.randomUUID()}`,
    );

    expect(await running(owner.projectId, owner.cookie)).toEqual({ status: 200, ids: [owner.conversationId] });
    expect(await running(owner.projectId, stranger.cookie)).toEqual({ status: 200, ids: [] });
  });
});

describe("a turn in progress", () => {
  it("is listed while it runs and gone as soon as it has answered", async () => {
    const owner = await seedOwner();
    closeGate();
    const res = await startTurn(owner);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await readUntil(reader, "text-delta");

    expect(await running(owner.projectId, owner.cookie)).toEqual({ status: 200, ids: [owner.conversationId] });

    gate.open();
    while (!(await reader.read()).done) {
      // Drain: the release happens before the stream closes.
    }

    expect(await running(owner.projectId, owner.cookie)).toEqual({ status: 200, ids: [] });
  });

  it("is gone soon after the client leaves mid-turn, long before a lease would run out", async () => {
    const owner = await seedOwner();
    closeGate();
    const res = await startTurn(owner);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await readUntil(reader, "text-delta");
    expect(await running(owner.projectId, owner.cookie)).toEqual({ status: 200, ids: [owner.conversationId] });

    await reader.cancel();

    // Five seconds against a fifteen-second lease: only the release clears it
    // this soon.
    expect(await untilNoneRunning(owner.projectId, owner.cookie, 5_000)).toEqual({ status: 200, ids: [] });
  });
});

describe("a lease Redis will not take", () => {
  it("is logged, and the turn still answers in full", async () => {
    const owner = await seedOwner();
    const errors = vi.fn();
    leaseErrors.spy = errors;
    broken.on = true;

    const res = await startTurn(owner);
    const chunks = frames(await res.text());
    broken.on = false;

    expect(res.status).toBe(200);
    expect(chunks.some((c) => c.type === "text-delta" && c.delta === "hi")).toBe(true);
    expect(chunks.some((c) => c.type === "finish")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(errors).toHaveBeenCalledWith(
      {
        err: expect.any(Error),
        userId: owner.userId,
        conversationId: owner.conversationId,
        projectId: owner.projectId,
      },
      "chat_running_lease_failed",
    );
  });
});
