// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a run's opening reads and writes in the store (inner#1717).
 *
 * A message's user row is written under the id the page sent it with, so a
 * run that opens again after a crash finds the row its predecessor wrote
 * instead of writing a second one. And before a run treats what was left taken
 * as unanswered, it asks the store which of those ids a stored reply already
 * answered: one the newest reply holds as a message taken in mid-turn, or one
 * whose user row's turn already has a reply.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { initCore } from "@breatic/core";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A user with a project and a conversation in it.
 * @returns The conversation's id.
 */
async function seedConversation(): Promise<string> {
  const tag = `open-${crypto.randomBytes(4).toString("hex")}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}) RETURNING id
  `;
  const conv = await conversationRepo.createConversation(user!.id, "deepseek/deepseek-v4.1-flash-1017");
  await conversationRepo.setProjectId(conv.id, project!.id);
  return conv.id;
}

/** Closes no waiting card; these conversations have none. */
const NO_CARD = (): never => {
  throw new Error("no card should be waiting");
};

/**
 * A user message's parts.
 * @param text - Its words.
 * @returns The parts.
 */
const said = (text: string): Array<{ type: "text"; text: string }> => [{ type: "text", text }];

describe("a user row written under its message's id", () => {
  it("is written once; a second write with the same id hands back the first (SR-10)", async () => {
    const c = await seedConversation();
    const id = crypto.randomUUID();
    const first = await messageRepo.addUserMessage(c, { role: "user", parts: said("hello") }, NO_CARD, { messageId: id });
    const again = await messageRepo.addUserMessage(c, { role: "user", parts: said("hello") }, NO_CARD, { messageId: id });
    expect(again.turnIndex).toBe(first.turnIndex);
    const rows = await sql<{ id: string; turn_index: number }[]>`SELECT id, turn_index FROM conversation_messages WHERE conversation_id = ${c}`;
    expect(rows).toEqual([{ id, turn_index: first.turnIndex }]);
  });

  it("never hands back another conversation's row (SR-10)", async () => {
    const c1 = await seedConversation();
    const c2 = await seedConversation();
    const id = crypto.randomUUID();
    await messageRepo.addUserMessage(c1, { role: "user", parts: said("hello") }, NO_CARD, { messageId: id });
    await expect(
      messageRepo.addUserMessage(c2, { role: "user", parts: said("hello") }, NO_CARD, { messageId: id }),
    ).rejects.toThrow();
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${c2}`;
    expect(rows[0]!.n).toBe(0);
  });
});

describe("which taken messages a stored reply already answered", () => {
  it("counts one the newest reply holds as taken in mid-turn (SR-08)", async () => {
    const c = await seedConversation();
    const turn = await messageRepo.addUserMessage(c, { role: "user", parts: said("open") }, NO_CARD, { messageId: crypto.randomUUID() });
    const m3 = crypto.randomUUID();
    await messageRepo.addMessage(c, {
      role: "assistant",
      turnIndex: turn.turnIndex,
      parts: [
        { type: "text", text: "A" },
        { type: "user-message", id: m3, sentAt: new Date().toISOString(), parts: said("more") },
      ],
    });
    const status = await messageRepo.takenStatus(c, [m3]);
    expect([...status.answered]).toEqual([m3]);
    expect(status.unansweredRows.size).toBe(0);
  });

  it("counts one whose user row's turn has a reply (SR-09)", async () => {
    const c = await seedConversation();
    const m1 = crypto.randomUUID();
    const turn = await messageRepo.addUserMessage(c, { role: "user", parts: said("open") }, NO_CARD, { messageId: m1 });
    await messageRepo.addMessage(c, { role: "assistant", turnIndex: turn.turnIndex, parts: [{ type: "text", text: "answer" }] });
    const status = await messageRepo.takenStatus(c, [m1]);
    expect([...status.answered]).toEqual([m1]);
  });

  it("hands back the turn of a user row that has no reply, as not answered (SR-07, SR-09b)", async () => {
    const c = await seedConversation();
    const b = crypto.randomUUID();
    const turn = await messageRepo.addUserMessage(c, { role: "user", parts: said("open") }, NO_CARD, { messageId: b });
    const status = await messageRepo.takenStatus(c, [b]);
    expect(status.answered.size).toBe(0);
    expect(status.unansweredRows.get(b)).toBe(turn.turnIndex);
  });

  it("knows nothing of an id that was never stored", async () => {
    const c = await seedConversation();
    const status = await messageRepo.takenStatus(c, [crypto.randomUUID()]);
    expect(status.answered.size).toBe(0);
    expect(status.unansweredRows.size).toBe(0);
  });

  it("does not count a mid-turn message held only by an older reply as answered by the newest", async () => {
    const c = await seedConversation();
    const old = crypto.randomUUID();
    const t1 = await messageRepo.addUserMessage(c, { role: "user", parts: said("one") }, NO_CARD, { messageId: crypto.randomUUID() });
    await messageRepo.addMessage(c, {
      role: "assistant",
      turnIndex: t1.turnIndex,
      parts: [{ type: "user-message", id: old, sentAt: new Date().toISOString(), parts: said("x") }],
    });
    const t2 = await messageRepo.addUserMessage(c, { role: "user", parts: said("two") }, NO_CARD, { messageId: crypto.randomUUID() });
    await messageRepo.addMessage(c, { role: "assistant", turnIndex: t2.turnIndex, parts: [{ type: "text", text: "y" }] });
    const status = await messageRepo.takenStatus(c, [old]);
    expect(status.answered.has(old)).toBe(false);
  });
});
