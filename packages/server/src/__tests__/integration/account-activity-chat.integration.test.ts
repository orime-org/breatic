// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import type { Hono } from "hono";
import type * as DomainModule from "@breatic/domain";
import { getAgentConfig, initCore, loadLocales } from "@breatic/core";
import { activityRows, rejectActivityWrites, seedActivityProject, seedActivityUser } from "./helpers/account-activity-fixture.js";
import type { ActivityProject } from "./helpers/account-activity-fixture.js";
import { waitUntilBlockedOn } from "./lock-probe.js";

const model = vi.hoisted(() => ({ fail: false }));
vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof DomainModule>();
  const { modelProducing, saying } = await import("../helpers/model-double.js");
  return {
    ...actual,
    resolveProvider: () => "deepseek",
    getModel: () => modelProducing(() => {
      if (model.fail) throw new Error("activity model fixture failed");
      return saying("ok");
    }),
  };
});

initCore(process.env);
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), { max: 10, prepare: false });
  app = (await import("@server/app.js")).createApp();
});
afterAll(async () => { await sql?.end({ timeout: 1 }); });
beforeEach(() => { model.fail = false; });

interface Chat extends ActivityProject {
  conversationId: string;
}

const QUESTION = { questions: [{ header: "Ratio", question: "Which ratio?", options: [{ label: "16:9" }, { label: "9:16" }] }] };

/**
 * Seed a conversation owned by the fixture's authenticated user, on the
 * model a new conversation starts on (#1363).
 * @returns The real account, Project, conversation and cookie.
 * @throws {Error} When a fixture insert fails.
 */
async function seedChat(): Promise<Chat> {
  const project = await seedActivityProject(sql);
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO conversations (user_id, project_id, agent_model)
    VALUES (${project.userId}, ${project.projectId}, ${getAgentConfig().default_model}) RETURNING id
  `;
  if (!conversation) throw new Error("activity conversation fixture was not inserted");
  return { ...project, conversationId: conversation.id };
}

/**
 * Store the same waiting card shape the real Agent persists.
 * @param chat - The account and conversation.
 * @param kind - Which of the two card protocols is waiting.
 * @returns The card identity and a matching HTTP answer body.
 * @throws {Error} When the fixture insert fails.
 */
async function seedCard(chat: Chat, kind: "questionnaire" | "space"): Promise<{ callId: string; answer: Record<string, unknown> }> {
  const callId = randomUUID();
  const toolName = kind === "questionnaire" ? "ask_user" : "request_space_content";
  const input = kind === "questionnaire" ? QUESTION : { reason: "Read the requested Space", spaces: [{ id: randomUUID() }] };
  const part = { type: "tool", toolCallId: callId, toolName, input, status: "awaiting" };
  const call = { role: "assistant", content: [{ type: "tool-call", toolCallId: callId, toolName, input }] };
  await sql`
    INSERT INTO conversation_messages (conversation_id, user_id, turn_index, seq, role, parts, for_model)
    VALUES (${chat.conversationId}, ${chat.userId}, 1, 0, 'user', ${sql.json([{ type: "text", text: "Please help" }])}, null),
           (${chat.conversationId}, ${chat.userId}, 1, 1, 'assistant', ${sql.json([part])},
            ${sql.json({ messages: [call], prefixHash: "activity", turnTokens: 1, endTokens: 1 })})
  `;
  return {
    callId,
    answer: kind === "questionnaire"
      ? { answer: { toolCallId: callId, answers: [{ index: 0, selected: ["16:9"] }] } }
      : { shared_spaces: { toolCallId: callId, decision: "declined" } },
  };
}

/**
 * Drive a real chat request and finish reading its stream or error response.
 * @param chat - The real authenticated caller.
 * @param body - The message or card answer.
 * @returns The actual status and response text.
 * @throws {Error} When the request cannot run.
 */
async function post(chat: Chat, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const response = await app.request("/api/v1/chat/message", {
    method: "POST",
    headers: { Cookie: chat.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: chat.projectId, conversation_id: chat.conversationId, message: "", ...body }),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Read the authoritative status of the stored card.
 * @param chat - The conversation.
 * @param callId - The tool call whose status is inspected.
 * @returns Its persisted card status.
 * @throws {Error} When the card was not found.
 */
async function cardStatus(chat: Chat, callId: string): Promise<string> {
  const rows = await sql<{ parts: Array<{ type: string; toolCallId?: string; status?: string }> }[]>`
    SELECT parts FROM conversation_messages WHERE conversation_id = ${chat.conversationId} AND role = 'assistant'
  `;
  const part = rows.flatMap((row) => row.parts).find((entry) => entry.type === "tool" && entry.toolCallId === callId);
  if (!part?.status) throw new Error("activity card fixture was not found");
  return part.status;
}

/**
 * Reject this conversation's card UPDATE only when its real transaction commits.
 * @param chat - The owned conversation whose deferred completion must fail.
 * @returns Cleanup for this fixture's constraint trigger and function.
 * @throws {Error} When installing or removing the real PG fixture fails.
 */
async function rejectCardCommit(chat: Chat): Promise<() => Promise<void>> {
  const fn = `card_commit_reject_${randomUUID().replaceAll("-", "")}`;
  await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.conversation_id='${chat.conversationId}'::uuid THEN RAISE EXCEPTION 'card deferred commit fixture rejected'; END IF;
    RETURN NEW;
  END $$`);
  try {
    await sql.unsafe(`CREATE CONSTRAINT TRIGGER ${fn}_t AFTER UPDATE ON conversation_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  } catch (error) {
    await sql.unsafe(`DROP FUNCTION ${fn}()`);
    throw error;
  }
  return async (): Promise<void> => {
    await sql.unsafe(`DROP TRIGGER ${fn}_t ON conversation_messages`);
    await sql.unsafe(`DROP FUNCTION ${fn}()`);
  };
}

describe("Agent activity acceptance and card transactions (inner#1893)", () => {
  it("P14 records an ordinary accepted message under the real caller before its turn completes", async () => {
    const chat = await seedChat();
    const response = await post(chat, { message: "Hello" });
    expect(response.status).toBe(200);
    const rows = await activityRows(sql, chat.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "agent_started", user_id: chat.userId, project_id: chat.projectId, visit_id: null });
  });

  it("P14 refuses an empty ordinary message before adding activity", async () => {
    const chat = await seedChat();
    expect((await post(chat, {})).status).toBe(422);
    expect(await activityRows(sql, chat.userId)).toEqual([]);
  });

  it("P14 refuses another account's conversation before adding activity", async () => {
    const chat = await seedChat();
    const other = await seedActivityUser(sql);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${chat.studioId}, ${other.userId}, 'guest')`;
    await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${chat.projectId}, ${other.userId}, 'editor')`;
    expect((await post({ ...chat, ...other }, { message: "Hello" })).status).toBe(404);
    expect(await activityRows(sql, other.userId)).toEqual([]);
  });

  it("P14 refuses a soft-deleted conversation before adding activity", async () => {
    const chat = await seedChat();
    await sql`UPDATE conversations SET deleted_at = now() WHERE id = ${chat.conversationId}`;
    expect((await post(chat, { message: "Hello" })).status).toBe(404);
    expect(await activityRows(sql, chat.userId)).toEqual([]);
  });

  for (const kind of ["questionnaire", "space"] as const) {
    it(`P15 consumes ${kind} and records one accepted answer in the same persistent result`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      expect((await post(chat, card.answer)).status).toBe(200);
      expect(await cardStatus(chat, card.callId)).toBe("success");
      expect((await activityRows(sql, chat.userId)).map((row) => ({ kind: row.kind, project: row.project_id }))).toEqual([{ kind: "agent_started", project: chat.projectId }]);
    });

    it(`P15 rejects a missing ${kind} call with no new activity`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      const body = kind === "questionnaire"
        ? { answer: { toolCallId: randomUUID(), answers: [{ index: 0, selected: ["16:9"] }] } }
        : { shared_spaces: { toolCallId: randomUUID(), decision: "declined" } };
      expect((await post(chat, body)).status).toBe(404);
      expect(await cardStatus(chat, card.callId)).toBe("awaiting");
      expect(await activityRows(sql, chat.userId)).toEqual([]);
    });

    it(`P15 rejects mismatched ${kind} input with no new activity`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      const body = kind === "questionnaire"
        ? { answer: { toolCallId: card.callId, answers: [{ index: 0, selected: ["wrong ratio"] }] } }
        : { shared_spaces: { toolCallId: card.callId, decision: "shared", spaces: [{ id: randomUUID(), state: "gone" }] } };
      expect((await post(chat, body)).status).toBe(422);
      expect(await cardStatus(chat, card.callId)).toBe("awaiting");
      expect(await activityRows(sql, chat.userId)).toEqual([]);
    });

    it(`P15 preserves a completed ${kind} answer and its original activity on replay`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      expect((await post(chat, card.answer)).status).toBe(200);
      await sql`UPDATE account_activity_events SET occurred_at = '2026-10-31T23:59:59.654321Z' WHERE user_id = ${chat.userId}`;
      const before = await activityRows(sql, chat.userId);
      expect((await post(chat, card.answer)).status).toBe(409);
      expect(await cardStatus(chat, card.callId)).toBe("success");
      expect(await activityRows(sql, chat.userId)).toEqual(before);
    });

    it(`P16 rolls ${kind} consumption back when its real activity INSERT fails`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      const restore = await rejectActivityWrites(sql, chat.userId);
      try {
        expect((await post(chat, card.answer)).status).toBe(500);
        expect(await cardStatus(chat, card.callId)).toBe("awaiting");
        expect(await activityRows(sql, chat.userId)).toEqual([]);
      } finally {
        await restore();
      }
      expect((await post(chat, card.answer)).status).toBe(200);
      expect(await cardStatus(chat, card.callId)).toBe("success");
      expect((await activityRows(sql, chat.userId)).map((row) => row.kind)).toEqual(["agent_started"]);
    });

    it(`P16 rolls ${kind} activity back when the card transaction fails at deferred COMMIT`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      const restore = await rejectCardCommit(chat);
      try {
        const response = await post(chat, card.answer);
        expect(response.status).toBe(500);
        expect(await cardStatus(chat, card.callId)).toBe("awaiting");
        expect(await activityRows(sql, chat.userId)).toEqual([]);
      } finally { await restore(); }
      expect((await post(chat, card.answer)).status).toBe(200);
      expect(await cardStatus(chat, card.callId)).toBe("success");
      expect((await activityRows(sql, chat.userId)).map((row) => row.kind)).toEqual(["agent_started"]);
    });

    it(`P17 serializes two real ${kind} answers at the conversation lock`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      let release = (): void => {};
      const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
      let locked = (): void => {};
      let fail = (_error: unknown): void => {};
      const ready = new Promise<void>((resolveReady, rejectReady) => { locked = resolveReady; fail = rejectReady; });
      const holder = sql.begin(async (tx) => {
        await tx`SELECT id FROM conversations WHERE id = ${chat.conversationId} FOR UPDATE`;
        locked();
        await gate;
      });
      void holder.catch(fail);
      await ready;
      const first = post(chat, card.answer);
      const second = post(chat, card.answer);
      try {
        await waitUntilBlockedOn(sql, ["conversations", "for update"], 2);
      } finally {
        release();
        await holder;
      }
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(await cardStatus(chat, card.callId)).toBe("success");
      expect((await activityRows(sql, chat.userId)).map((row) => row.kind)).toEqual(["agent_started"]);
    });

    it(`P17 preserves committed ${kind} activity after the model stream fails`, async () => {
      const chat = await seedChat();
      const card = await seedCard(chat, kind);
      model.fail = true;
      const response = await post(chat, card.answer);
      expect(response.status).toBe(200);
      expect(await cardStatus(chat, card.callId)).toBe("success");
      expect((await activityRows(sql, chat.userId)).map((row) => row.kind)).toEqual(["agent_started"]);
    });
  }

  it("P18 keeps text-tool activity account-scoped when a client supplies a Project", async () => {
    const project = await seedActivityProject(sql);
    const response = await app.request("/api/v1/mini-tools/text", {
      method: "POST",
      headers: { Cookie: project.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ tool: "polish", document: "Hello", selection: "Hello", project_id: randomUUID() }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect((await activityRows(sql, project.userId)).map((row) => ({ kind: row.kind, project: row.project_id }))).toEqual([{ kind: "agent_started", project: null }]);
  });

  it("P14 refuses a valid message naming an inaccessible Project", async () => {
    const chat = await seedChat();
    const other = await seedActivityProject(sql);
    expect((await post(chat, { project_id: other.projectId, message: "Hello" })).status).toBe(404);
    expect(await activityRows(sql, chat.userId)).toEqual([]);
  });

  it("P14 refuses an owned conversation paired with another accessible Project", async () => {
    const chat = await seedChat();
    const other = await seedActivityProject(sql);
    await sql`INSERT INTO studio_members(studio_id,user_id,role) VALUES(${other.studioId},${chat.userId},'guest')`;
    await sql`INSERT INTO project_members(project_id,user_id,role) VALUES(${other.projectId},${chat.userId},'editor')`;
    expect((await post(chat, { project_id: other.projectId, message: "Hello" })).status).toBe(404);
    expect(await activityRows(sql, chat.userId)).toEqual([]);
  });

  it("P14 refuses an ordinary turn without available credits before recording activity", async () => {
    const chat = await seedChat();
    initCore({ ...process.env, PAYMENT_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_unused_activity_fixture", STRIPE_WEBHOOK_SECRET: "whsec_unused_activity_fixture" });
    try {
      expect((await post(chat, { message: "Hello" })).status).toBe(402);
      expect(await activityRows(sql, chat.userId)).toEqual([]);
    } finally { initCore(process.env); }
  });

  it("P18 refuses unauthenticated and malformed text tools without recording activity", async () => {
    const project = await seedActivityProject(sql);
    const anonymous = await app.request("/api/v1/mini-tools/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "polish", document: "text", selection: "text" }) });
    expect(anonymous.status).toBe(401);
    const malformed = await app.request("/api/v1/mini-tools/text", { method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ tool: "polish" }) });
    expect(malformed.status).toBe(422);
    expect(await activityRows(sql, project.userId)).toEqual([]);
  });


  it("P14 refuses an ordinary turn before opening SSE when activity persistence fails", async () => {
    const chat = await seedChat();
    const restore = await rejectActivityWrites(sql, chat.userId);
    try {
      const response = await post(chat, { message: "Hello" });
      expect(response.status).toBe(500);
      const messages = await sql`SELECT id FROM conversation_messages WHERE conversation_id=${chat.conversationId}`;
      expect(messages).toEqual([]);
      expect(await activityRows(sql, chat.userId)).toEqual([]);
    } finally { await restore(); }
  });

  it("P18 preserves SSE error feedback when account-scoped activity persistence fails", async () => {
    const project = await seedActivityProject(sql);
    const restore = await rejectActivityWrites(sql, project.userId);
    try {
      const response = await app.request("/api/v1/mini-tools/text", {
        method: "POST", headers: { Cookie: project.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "polish", document: "Hello", selection: "Hello", project_id: randomUUID() }),
      });
      expect(response.status).toBe(200);
      const stream = await response.text();
      expect(stream).toContain("event: error");
      expect(await activityRows(sql, project.userId)).toEqual([]);
    } finally { await restore(); }
  });

});
