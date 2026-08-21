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
import { compressForContext } from "@server/agent/message-compressor.js";

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
  const conv = await conversationRepo.createConversation(userId);
  await conversationRepo.setProjectId(conv.id, projectId);
  return { ...conv, projectId };
}

describe("messages", () => {
  it("reads back in the order they were written", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    const asked = await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "one" }] });
    await messageRepo.addMessage(conv.id, { role: "assistant", parts: [{ type: "text", text: "two" }], turnIndex: asked });
    await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "three" }] });

    const page = await messageRepo.getMessages(conv.id);
    expect(page.messages.map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("opens a new turn on each user message", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    const t1 = await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "q1" }] });
    await messageRepo.addMessage(conv.id, { role: "assistant", parts: [{ type: "text", text: "a1" }], turnIndex: t1 });
    const t2 = await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "q2" }] });

    // A reply in between does not consume a number: it joins the turn its
    // question opened. Where the reply itself ends up is asserted below,
    // where it can still fail -- reading back the number just handed in
    // would hold whatever the store did with it.
    expect(t2).toBe(t1 + 1);
  });

  it("keeps a reply in the turn it answers, even when the next turn opened first", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    // One user, two browser tabs. `openChat` hands both of them the same
    // conversation, so both questions can be stored before either reply comes
    // back -- the test above never sees this because it stores its reply while
    // its own turn is still the newest one.
    const asked = await messageRepo.addMessage(conv.id, {
      role: "user",
      parts: [{ type: "text", text: "q1" }],
    });
    await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "q2" }] });

    // The reply to the FIRST question arrives now. Which turn it belongs to is
    // something only its caller knows: the store cannot read it off the table,
    // because by this point the newest turn is somebody else's.
    await messageRepo.addMessage(conv.id, {
      role: "assistant",
      parts: [{ type: "text", text: "a1" }],
      turnIndex: asked,
    });

    const { messages: stored } = await messageRepo.getMessages(conv.id);
    const reply = stored.find((m) => m.role === "assistant");

    // Reading the conversation back has to show a1 under q1. Filed under the
    // later turn it reads as an answer to a question nobody asked there, and
    // q1 reads as a question that was never answered.
    expect(reply?.turnIndex).toBe(asked);
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
    const first = messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "p" }] });
    await waitUntilBlockedOn(sql, ["conversations", "for update"], 1);
    const second = messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "q" }] });
    await waitUntilBlockedOn(sql, ["conversations", "for update"], 2);

    releaseGate();
    await gate;

    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBe(b);
  });

  it("hides its messages once the conversation is soft-deleted", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);
    await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "one" }] });

    await conversationRepo.softDeleteConversation(conv.id);

    expect((await messageRepo.getMessages(conv.id)).messages).toEqual([]);

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
      const asked = await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "already here" }] });

      await Promise.allSettled([
        messageRepo.addMessage(conv.id, { role: "assistant", parts: [{ type: "text", text: "still writing" }], turnIndex: asked }),
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
  // A message is its parts, so what goes in has to come back out piece for
  // piece. A lossy mapping here silently eats a tool call or the reasoning
  // behind a reply, and nothing else in the system would notice.
  const partArb = fc.oneof(
    fc.record({
      type: fc.constant("text" as const),
      text: fc.string({ minLength: 1 }),
    }),
    fc.record({
      type: fc.constant("reasoning" as const),
      text: fc.string({ minLength: 1 }),
    }),
    fc.record({
      type: fc.constant("tool" as const),
      toolCallId: fc.uuid(),
      toolName: fc.string({ minLength: 1 }),
      // Round-tripped through JSON before it is used, so the generator only
      // produces values JSON can carry. It cannot carry negative zero —
      // `JSON.stringify(-0)` is `"0"` — and vitest's `toEqual` tells the two
      // apart, so a generated -0 failed this property about one run in five
      // while every other value passed. Normalising the input rather than the
      // stored result keeps the property intact: a real storage defect still
      // shows up as a difference.
      input: fc
        .dictionary(fc.string({ minLength: 1 }), fc.jsonValue())
        .map((d) => JSON.parse(JSON.stringify(d)) as Record<string, unknown>),
      status: fc.constantFrom("pending" as const, "success" as const, "error" as const),
      output: fc.string(),
    }),
    fc.record({ type: fc.constant("interrupted" as const) }),
    fc.record({ type: fc.constant("failed" as const) }),
  );

  // A reply carries the turn it answers; a question is given one. So the two
  // roles are drawn separately rather than as one record with a role field.
  const messageArb = fc.oneof(
    fc.record({
      role: fc.constant("user" as const),
      parts: fc.array(partArb, { minLength: 1, maxLength: 4 }),
    }),
    fc.record({
      role: fc.constant("assistant" as const),
      parts: fc.array(partArb, { minLength: 1, maxLength: 4 }),
      turnIndex: fc.constant(1),
    }),
  );

  it("comes back with every part it went in with", async () => {
    const { userId, projectId } = await seedProject();

    await fc.assert(
      fc.asyncProperty(messageArb, async (message) => {
        const conv = await seedConversation(userId, projectId);
        await messageRepo.addMessage(conv.id, message);
        const [stored] = (await messageRepo.getMessages(conv.id)).messages;

        expect(stored!.role).toBe(message.role);
        expect(stored!.parts).toEqual(message.parts);

        // The flat fields are read off the parts, never stored beside them.
        const prose = message.parts
          .filter((p) => p.type === "text")
          .map((p) => (p as { text: string }).text)
          .join("");
        expect(stored!.content).toBe(prose);

        // `ts` is created_at rendered as ISO — one source of truth, not a
        // second timestamp the caller has to keep in sync.
        expect(new Date(stored!.ts).toString()).not.toBe("Invalid Date");

        // The row's own id comes back, which is what a client keys on.
        expect(stored!.id).toMatch(/^[0-9a-f-]{36}$/);

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
      parts: [{ type: "interrupted" }],
      turnIndex: 1,
    });
    const [stored] = (await messageRepo.getMessages(conv.id)).messages;

    expect(stored).toMatchObject({ role: "assistant", content: "", interrupted: true });
    expect(stored!.parts).toEqual([{ type: "interrupted" }]);
  });

  it("keeps a turn that failed before it said anything distinguishable from nothing", async () => {
    // The other ending that does not finish. Same guarantee as above and for
    // the same reason: a turn that fails on its first token has nothing else
    // to store, so without the marker the row is an empty list — and what the
    // user said would sit alone with no answer and no reason.
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    await messageRepo.addMessage(conv.id, {
      role: "assistant",
      parts: [{ type: "failed" }],
      turnIndex: 1,
    });
    const [stored] = (await messageRepo.getMessages(conv.id)).messages;

    expect(stored).toMatchObject({ role: "assistant", content: "", failed: true });
    expect(stored!.parts).toEqual([{ type: "failed" }]);
  });
});

describe("reading a conversation longer than one page", () => {
  it("hands out every message exactly once as the reader walks back", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    // Thirty turns, one of which was stopped before the model said anything.
    // That turn is one message where the others are two, which is what puts
    // the page boundary inside a turn rather than neatly between two: the
    // running total from the newest end goes 2, 3, 5, 7 ... and steps over
    // fifty instead of landing on it.
    for (let i = 1; i <= 30; i++) {
      const turn = await messageRepo.addMessage(conv.id, {
        role: "user",
        parts: [{ type: "text", text: `q${i}` }],
      });
      if (i === 29) continue;
      await messageRepo.addMessage(conv.id, {
        role: "assistant",
        parts: [{ type: "text", text: `a${i}` }],
        turnIndex: turn,
      });
    }

    const seen: string[] = [];
    let page = await messageRepo.getMessages(conv.id);
    expect(page.hasMore).toBe(true);
    for (;;) {
      seen.push(...page.messages.map((m) => m.id ?? ""));
      if (!page.hasMore) break;
      const oldest = Math.min(...page.messages.map((m) => m.turnIndex));
      page = await messageRepo.getMessages(conv.id, { beforeTurn: oldest });
    }

    // Every message the conversation has, and no message twice. A boundary
    // that cuts a turn in half loses whichever half falls outside both pages:
    // on screen that is an answer with no question above it, and no amount of
    // loading earlier ever brings it back.
    const stored = await sql<{ id: string }[]>`
      SELECT id::text FROM conversation_messages
      WHERE conversation_id = ${conv.id} AND deleted_at IS NULL
    `;
    expect(seen.length).toBe(stored.length);
    expect(new Set(seen).size).toBe(stored.length);
  });
});

describe("the memory chain still sees the same messages", () => {
  it("counts the turns past the consolidated watermark", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    for (let i = 0; i < 5; i++) {
      const turn = await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: `q${i}` }] });
      await messageRepo.addMessage(conv.id, { role: "assistant", parts: [{ type: "text", text: `a${i}` }], turnIndex: turn });
    }
    await conversationRepo.updateConsolidatedTurn(conv.id, 2);

    // Five user messages → turns 1..5; watermark at 2 leaves three.
    expect(await messageRepo.getUnconsolidatedTurnCount(conv.id)).toBe(3);
  });

  it("does not move the conversation when it records what it consolidated", async () => {
    // 归纳是 fire-and-forget 的:它落地时读者可能已经在另一条会话里说过话了。
    // 动了 updated_at,这条没人在说话的会话会反超到列表最前,下次打开 project
    // 也落在它上面 —— 而归纳对读者是不可见的簿记。
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);
    const turn = await messageRepo.addMessage(conv.id, {
      role: "user",
      parts: [{ type: "text", text: "q" }],
    });
    await messageRepo.addMessage(conv.id, {
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
      turnIndex: turn,
    });
    const before = await conversationRepo.getConversation(conv.id);

    await conversationRepo.updateConsolidatedTurn(conv.id, 1);

    const after = await conversationRepo.getConversation(conv.id);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it("hands consolidation exactly the turns inside the window", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    for (let i = 1; i <= 6; i++) {
      const turn = await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: `q${i}` }] });
      await messageRepo.addMessage(conv.id, { role: "assistant", parts: [{ type: "text", text: `a${i}` }], turnIndex: turn });
    }

    // Turns 1..6 exist, 1 is already consolidated, the last 2 are kept back:
    // the window is turns 2..4.
    const window = await messageRepo.getMessagesForConsolidation(conv.id, 1, 2);
    expect(window.map((m) => m.content)).toEqual(["q2", "a2", "q3", "a3", "q4", "a4"]);
  });

  it("skips consolidated turns and drops the flat mirror of the reasoning", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    await messageRepo.addMessage(conv.id, { role: "user", parts: [{ type: "text", text: "old" }] });
    const turn = await messageRepo.addMessage(conv.id, {
      role: "user",
      parts: [{ type: "text", text: "new" }],
    });
    await messageRepo.addMessage(conv.id, {
      role: "assistant",
      parts: [
        { type: "reasoning", text: "the user probably means" },
        { type: "text", text: "here you go" },
      ],
      turnIndex: turn,
    });

    const forLlm = await messageRepo.getMessagesForLlm(conv.id, 1);
    expect(forLlm.map((m) => m.content)).toEqual(["new", "here you go"]);
    // Reasoning is the model's own working: sending it back teaches nothing
    // and is paid for every turn.
    expect(forLlm[1]).not.toHaveProperty("thinking");
    // The turn index stays, because the compressor between here and the model
    // groups by it. Dropping it left every message in one group and the
    // compressing branch unreachable.
    expect(forLlm[1]?.turnIndex).toBe(turn);
  });

  it("compresses the turns past the detail window, read the way the route reads them", async () => {
    const { userId, projectId } = await seedProject();
    const conv = await seedConversation(userId, projectId);

    for (let i = 1; i <= 5; i++) {
      const turn = await messageRepo.addMessage(conv.id, {
        role: "user",
        parts: [{ type: "text", text: `q${i}` }],
      });
      await messageRepo.addMessage(conv.id, {
        role: "assistant",
        turnIndex: turn,
        parts: [
          {
            type: "tool",
            toolCallId: `call-${i}`,
            toolName: "web_fetch",
            input: { url: "https://example.com" },
            status: "success",
            output: "page text",
          },
          { type: "text", text: `a${i}` },
        ],
      });
    }

    // Both chat routes build the model's context in exactly these two steps,
    // so the test takes them together: whether compression runs is a property
    // of the pair, not of either half.
    const forLlm = await messageRepo.getMessagesForLlm(conv.id, 0);
    const context = compressForContext(forLlm, 3);

    // Five turns, the last three kept whole. Turns 1 and 2 are old enough to
    // lose their tool use -- that is the entire point of compressing them, and
    // the older the conversation the larger the share of the context it saves.
    const keptToolUse = context.filter((m) => m.parts.some((p) => p.type === "tool"));
    expect(keptToolUse.map((m) => m.content)).toEqual(["a3", "a4", "a5"]);
  });
});
