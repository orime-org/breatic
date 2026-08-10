// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Behaviour of the chat storage layer (PR-3) against a real Postgres.
 *
 * The structural half (columns, the unique index, the FK delete rules, the
 * `parts` default) lives in chat-storage-schema.integration.test.ts. This suite pins the behaviour that
 * only shows up when two statements race or when a row is soft-deleted
 * underneath a pointer:
 *
 *   - Turn numbering is a billing key (`turn:${conversationId}:${turnIndex}`).
 *     Two concurrent user messages that compute the same turn index collide on
 *     the idempotency key, and one of the two turns goes unbilled.
 *
 *   - The memory chain reads messages through the same repository. Moving
 *     messages out of the JSONB column moves the ground under it, so its two
 *     read functions are pinned here as well.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

// `ai` is stubbed: the real SDK is replaced with a double that reaches no
// network, so this suite needs no API key and the SDK stays out of its
// module graph.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

import postgres from "postgres";
import fc from "fast-check";
import { initCore } from "@breatic/core";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import * as conversationRepo from "@server/modules/conversation/conversation.repo.js";
import * as messageRepo from "@server/modules/conversation/conversation-message.repo.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}

const PG_DRIVER_LOCAL = "chat-storage-behaviour-test-driver";

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 8,
    prepare: false,
    connection: { application_name: PG_DRIVER_LOCAL },
  });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/**
 * Seed an owner with a studio and a project they can write to.
 * @returns The freshly created user and project ids.
 */
async function seedProject(): Promise<{ userId: string; projectId: string }> {
  const tag = `cs-${seq++}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${tag}@example.com`}, true) RETURNING id
  `;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${user!.id}, ${`${tag}-studio`}, 'personal', ${tag}) RETURNING id
  `;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studio!.id}, ${user!.id}, ${tag}, ${`${tag}-p`}, 'studio') RETURNING id
  `;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studio!.id}, ${user!.id}, 'admin')
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${project!.id}, ${user!.id}, 'owner', null)
  `;
  return { userId: user!.id, projectId: project!.id };
}

/**
 * Create a conversation in a project, the way opening chat would.
 * @param userId - Owner of the conversation.
 * @param projectId - Project it belongs to.
 * @returns The created conversation.
 */
async function seedConversation(userId: string, projectId: string) {
  const conv = await conversationRepo.createConversation(userId, "seeded");
  await conversationRepo.setProjectId(conv.id, projectId);
  return { ...conv, projectId };
}

describe("messages", () => {
  it("reads back in the order they were written", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    await messageRepo.addMessage(conv.id, { role: "user", content: "one" });
    await messageRepo.addMessage(conv.id, { role: "assistant", content: "two" });
    await messageRepo.addMessage(conv.id, { role: "user", content: "three" });

    const msgs = await messageRepo.getMessages(conv.id);
    expect(msgs.map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("opens a new turn on each user message and keeps replies in that turn", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    const t1 = await messageRepo.addMessage(conv.id, { role: "user", content: "q1" });
    const r1 = await messageRepo.addMessage(conv.id, { role: "assistant", content: "a1" });
    const t2 = await messageRepo.addMessage(conv.id, { role: "user", content: "q2" });

    expect(r1).toBe(t1);
    expect(t2).toBe(t1 + 1);
  });

  it("parks on the conversation row, so two user messages cannot share a turn", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    // Firing two calls with Promise.all proves nothing here: the pool hands
    // the second one the connection the first just returned, so they run one
    // after the other and the test passes whether or not a lock exists —
    // measured, not assumed. Parking a real lock in the way is what turns
    // "they serialise" into an observed fact.
    let announceLock: () => void = () => {};
    const gateHoldsLock = new Promise<void>((r) => {
      announceLock = r;
    });
    let releaseGate: () => void = () => {};
    const gateReleased = new Promise<void>((r) => {
      releaseGate = r;
    });

    const gate = sql.begin(async (tx) => {
      await tx`SELECT 1 FROM conversations WHERE id = ${conv.id} FOR UPDATE`;
      announceLock();
      await gateReleased;
    });
    await gateHoldsLock;

    // Both appends must be waiting on that row before the gate lets go. If
    // they are not, the append is computing its turn index without holding
    // anything, which is exactly the race that lets two turns share a billing
    // key. The second wait asks for two parked backends, not just "somebody is
    // parked" — the first append is still there, so a probe that stops at one
    // would return before the second append had issued a single statement and
    // the two would then run in sequence, passing for the wrong reason.
    const first = messageRepo.addMessage(conv.id, { role: "user", content: "p" });
    await waitUntilBlockedOn(sql, ["conversations", "for update"], 1);
    const second = messageRepo.addMessage(conv.id, { role: "user", content: "q" });
    await waitUntilBlockedOn(sql, ["conversations", "for update"], 2);

    releaseGate();
    await gate;

    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBe(b);
  });

  it("hides its messages once the conversation is soft-deleted", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);
    await messageRepo.addMessage(conv.id, { role: "user", content: "one" });

    await conversationRepo.softDeleteConversation(conv.id);

    expect(await messageRepo.getMessages(conv.id)).toEqual([]);

    // The FK is RESTRICT, so Postgres will not cascade for us — the service
    // layer has to stamp the children itself.
    const rows = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM conversation_messages WHERE conversation_id = ${conv.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deleted_at).not.toBeNull();
  });
});

describe("deleting a conversation while it is still being written to", () => {
  it("never leaves a live message under a deleted conversation", async () => {
    // A turn appends several messages seconds apart (the assistant's reply, a
    // tool call, its result). Deleting mid-turn is an ordinary thing to do.
    // Whatever order the two land in, one thing has to hold afterwards: a
    // deleted conversation has no live messages. Either the append got in
    // first and was stamped with the rest, or it was refused outright.
    //
    // Five rounds because the interleaving is probabilistic — the delete's
    // parent UPDATE parks behind the append's row lock, so it almost always
    // lands last, but "almost" is why one round would be flaky.
    for (let round = 0; round < 5; round++) {
      const { userId, projectId } = await seedProject();
      const conv = await seedConversation(userId, projectId);
      await messageRepo.addMessage(conv.id, { role: "user", content: "already here" });

      await Promise.allSettled([
        messageRepo.addMessage(conv.id, { role: "assistant", content: "still writing" }),
        conversationRepo.softDeleteConversation(conv.id),
      ]);

      const stranded = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n
        FROM conversation_messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = ${conv.id}
          AND m.deleted_at IS NULL
          AND c.deleted_at IS NOT NULL
      `;
      expect(Number(stranded[0]!.n)).toBe(0);
    }
  });
});

describe("a message survives the round trip through parts", () => {
  // Five shapes reach `addMessage` today (main-agent.ts): a plain user
  // message, a skill command, an assistant announcing a tool call, the tool
  // result that follows it, and an assistant reply that may carry reasoning.
  // Storage now splits a message into `parts`, so every one of those shapes
  // has to come back out unchanged — a lossy mapping silently eats tool
  // results or reasoning, and nothing else in the system would notice.
  const messageArb = fc.oneof(
    fc.record({
      role: fc.constantFrom("user" as const, "assistant" as const),
      content: fc.string({ minLength: 1 }),
    }),
    fc.record({
      role: fc.constant("assistant" as const),
      content: fc.string({ minLength: 1 }),
      thinking: fc.string({ minLength: 1 }),
    }),
    fc.record({
      role: fc.constant("assistant" as const),
      content: fc.constant(""),
      tool_calls: fc.array(
        fc.record({
          id: fc.uuid(),
          name: fc.string({ minLength: 1 }),
          arguments: fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()),
          result: fc.option(
            fc.dictionary(fc.string({ minLength: 1 }), fc.jsonValue()),
            { nil: undefined },
          ),
        }),
        { minLength: 1, maxLength: 3 },
      ),
    }),
    fc.record({
      role: fc.constant("tool" as const),
      content: fc.string(),
      tool_call_id: fc.uuid(),
      name: fc.string({ minLength: 1 }),
    }),
    // A turn the user stopped, with whatever it had written by then.
    fc.record({
      role: fc.constant("assistant" as const),
      content: fc.string(),
      interrupted: fc.constant(true as const),
    }),
  );

  it("comes back with every field it went in with", async () => {
    const { userId, projectId } = await seedProject();

    await fc.assert(
      fc.asyncProperty(messageArb, async (message) => {
        const conv = await seedConversation(userId, projectId);
        await messageRepo.addMessage(conv.id, message);
        const [stored] = await messageRepo.getMessages(conv.id, 1);

        // `ts` and `turnIndex` are assigned by the store, not the caller.
        const { ts: _ts, turnIndex: _turn, ...roundTripped } = stored!;
        expect(roundTripped).toEqual(message);

        // `ts` is created_at rendered as ISO — one source of truth, not a
        // second timestamp the caller has to keep in sync.
        expect(new Date(stored!.ts).toString()).not.toBe("Invalid Date");

        await conversationRepo.softDeleteConversation(conv.id);
      }),
      { numRuns: 25 },
    );
  });

  it("keeps a stopped turn that got no words out distinguishable from nothing", async () => {
    // The one case the marker exists for, pinned on its own rather than left
    // to the generator above to stumble on: a turn stopped after a tool call
    // and before any prose has no text, no reasoning and no tool call of its
    // own, so the marker is the only piece it leaves. Store it in a way that
    // drops the marker and the row is an empty list — which reads back as a
    // turn that never happened.
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    await messageRepo.addMessage(conv.id, {
      role: "assistant",
      content: "",
      interrupted: true,
    });
    const [stored] = await messageRepo.getMessages(conv.id, 1);

    expect(stored).toMatchObject({ role: "assistant", content: "", interrupted: true });
  });
});

describe("the memory chain still sees the same messages", () => {
  it("counts the turns past the consolidated watermark", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    for (let i = 0; i < 5; i++) {
      await messageRepo.addMessage(conv.id, { role: "user", content: `q${i}` });
      await messageRepo.addMessage(conv.id, { role: "assistant", content: `a${i}` });
    }
    await conversationRepo.updateConsolidatedTurn(conv.id, 2);

    // Five user messages → turns 1..5; watermark at 2 leaves three.
    expect(await messageRepo.getUnconsolidatedTurnCount(conv.id)).toBe(3);
  });

  it("hands consolidation exactly the turns inside the window", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    for (let i = 1; i <= 6; i++) {
      await messageRepo.addMessage(conv.id, { role: "user", content: `q${i}` });
      await messageRepo.addMessage(conv.id, { role: "assistant", content: `a${i}` });
    }

    // Turns 1..6 exist, 1 is already consolidated, the last 2 are kept back:
    // the window is turns 2..4.
    const window = await messageRepo.getMessagesForConsolidation(conv.id, 1, 2);
    expect(window.map((m) => m.content)).toEqual(["q2", "a2", "q3", "a3", "q4", "a4"]);
  });

  it("strips internal fields and consolidated turns for the LLM", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    await messageRepo.addMessage(conv.id, { role: "user", content: "old" });
    await messageRepo.addMessage(conv.id, { role: "user", content: "new" });

    const forLlm = await messageRepo.getMessagesForLlm(conv.id, 1);
    expect(forLlm.map((m) => m.content)).toEqual(["new"]);
    expect(forLlm[0]).not.toHaveProperty("turnIndex");
    expect(forLlm[0]).not.toHaveProperty("ts");
  });
});
