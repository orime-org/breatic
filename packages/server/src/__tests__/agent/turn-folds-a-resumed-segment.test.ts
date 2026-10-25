// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Folding in the segment that resumes after a questionnaire, and what a fold
 * changes about the message the turn sends (inner#1567, A3; design 6.4.5 and
 * 6.5).
 *
 * The resumed segment reads its own turn as history, so a fold there may take
 * only the turns before it. A fold changes the memory in the system prompt,
 * so every thinking block replayed after it -- the paused step's included --
 * goes out stripped, signature and all. And the reader's message is laid out
 * again: an open Space that went as "unchanged" pointed at a full copy the
 * fold may just have taken, so the reassembled message carries it in full and
 * replaces what was kept of the message.
 *
 * Window 1,048,576, output reserve 16,384, keep line 1,000,000, memory reserve
 * 4,000. Against H1's 1,048,577, two earlier turns of about 9,000 characters
 * are enough to fit once taken (more than 16,385) and not enough to reach the
 * fold's target (less than 20,385), so a planner free to take the running
 * turn would take it too.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { askResultForModel } from "@server/agent/ask-result.js";
import { openSpaceKey } from "@server/agent/user-turn.js";
import {
  PROBE_WINDOW,
  SIGNATURE,
  answers,
  asks,
  h1,
  plainTurn,
  resetWorld,
  rowsOf,
  sendAnswer,
  sendMessage,
  typesOf,
  world,
} from "../helpers/overflow-turn.js";

vi.mock("@breatic/core", async (importOriginal) => (await import("../helpers/overflow-turn.js")).overflowCore(importOriginal));
vi.mock("@breatic/domain", async () => (await import("../helpers/overflow-turn.js")).overflowDomain());
vi.mock("@server/modules", async (importOriginal) => (await import("../helpers/mock-core.js")).serverModulesMock(importOriginal));
vi.mock("@server/modules/conversation/conversation-message.repo.js", async () => (await import("../helpers/overflow-turn.js")).overflowRepo());
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ titleForTurn: async () => null }));
vi.mock("@server/agent/turn-context.js", async () => (await import("../helpers/overflow-turn.js")).overflowTurnContext());
vi.mock("@server/agent/memory-consolidator.js", async () => (await import("../helpers/overflow-turn.js")).overflowConsolidator());
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/** The Space the reader has open throughout. */
const OPEN = { id: "s1", name: "Board", kind: "timeline", state: "loaded", content: "SPACE-BODY-1234", total_chars: 15 } as const;
const SPACE = { spaces: [], current_space: OPEN };

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T09:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetWorld();
  world.window = PROBE_WINDOW;
});

/**
 * Two earlier turns; the first carried the open Space in full.
 * @param size - Characters in each earlier reply.
 * @throws {Error} When the key of the open Space cannot be worked out.
 */
function earlierTurns(size: number): void {
  const key = openSpaceKey(OPEN);
  if (key === undefined) throw new Error("the open Space has no key");
  const first = plainTurn(1, size);
  const asked: ModelMessage = { role: "user", content: `question 1\n\n${OPEN.content}` };
  first[0] = { ...first[0]!, forModel: { messages: [asked], snapshot: { ...key, full: true } } };
  world.history = [...first, ...plainTurn(2, size)];
  world.nextTurn = 3;
}

/**
 * Run turn 3 to a questionnaire, and settle the reader's answer into the row
 * that asked, the way the route does before resuming.
 * @throws {Error} When the turn stored no reply.
 */
async function pausedAtQuestionnaire(): Promise<void> {
  world.script = [asks("ask-1", 100, 10, true)];
  await sendMessage("make me a poster", SPACE);
  const rows = rowsOf(3);
  const reply = rows.find((row) => row.role === "assistant");
  if (reply === undefined) throw new Error("turn 3 stored no reply");
  (reply.forModel as { messages: ModelMessage[] }).messages.push(askResultForModel("ask-1", { answers: [] }));
  reply.parts = reply.parts.map((part) =>
    part.type === "tool" && part.toolCallId === "ask-1" ? { ...part, status: "success", output: { answers: [] } } : part,
  );
  world.history = [...world.history, ...rows];
  world.prompts = [];
  world.events = [];
  world.folds = [];
  world.replies = [];
  world.userForModel = [];
}

/**
 * The last user message one request carried, as text.
 * @param prompt - What one model call was handed.
 * @returns The message, serialised, or an empty string when there was no call.
 */
function lastUser(prompt: unknown[] | undefined): string {
  return JSON.stringify((prompt ?? []).filter((m) => (m as { role: string }).role === "user").at(-1)) ?? "";
}

describe("a fold in the segment resumed after a questionnaire", () => {
  it("takes only turns before the one it resumes, and carries on", async () => {
    earlierTurns(9_000);
    await pausedAtQuestionnaire();
    world.script = [{ reject: h1() }, answers("the poster plan")];

    const chunks = await sendAnswer("ask-1", 3, SPACE);

    expect(world.folds.map((f) => f.newWatermark)).toEqual([2]);
    const groups = world.folds[0]?.turns as Array<{ turnIndex: number }> | undefined;
    expect(groups?.map((group) => group.turnIndex)).toEqual([1, 2]);
    expect(JSON.stringify(world.folds[0])).not.toContain("ask-1");
    expect(typesOf(chunks)).not.toContain("error");
    expect(world.replies.at(-1)?.message.parts).toContainEqual({ type: "text", text: "the poster plan" });
  });

  it("sends the paused step without its thinking or signature once it has folded", async () => {
    earlierTurns(9_000);
    await pausedAtQuestionnaire();
    world.script = [{ reject: h1() }, answers("the poster plan")];

    await sendAnswer("ask-1", 3, SPACE);

    // Before the fold the paused step went out as it was sent, thinking and all.
    expect(JSON.stringify(world.prompts[0])).toContain(SIGNATURE);
    const resent = JSON.stringify(world.prompts[1]);
    expect(world.prompts).toHaveLength(2);
    expect(resent).toContain("ask-1");
    expect(resent).not.toContain(SIGNATURE);
    expect(resent).not.toContain("PAUSED-STEP-THINKING");
    expect(resent).not.toContain('"type":"reasoning"');
  });

  it("resends the segment's own message laid out again, and keeps that one", async () => {
    earlierTurns(9_000);
    await pausedAtQuestionnaire();
    world.script = [{ reject: h1() }, answers("the poster plan")];

    await sendAnswer("ask-1", 3, SPACE);

    // Turn 1 held the full copy the "unchanged" line pointed at, and is folded.
    expect(lastUser(world.prompts[0])).not.toContain(OPEN.content);
    expect(lastUser(world.prompts[1])).toContain(OPEN.content);
    const kept = world.replies.at(-1)?.forModel as { messages: ModelMessage[]; snapshot?: { full: boolean } } | undefined;
    expect(JSON.stringify(kept?.messages[0])).toContain(OPEN.content);
    expect(kept?.snapshot?.full).toBe(true);
  });
});

describe("a fold in a turn opened by a message", () => {
  it("resends the reader's message laid out again and writes it as the turn's user_for_model", async () => {
    earlierTurns(30_000);
    world.script = [{ reject: h1() }, answers("ok")];

    await sendMessage("and now?", SPACE);

    expect(world.folds.map((f) => f.newWatermark)).toEqual([1]);
    expect(lastUser(world.prompts[0])).not.toContain(OPEN.content);
    expect(lastUser(world.prompts[1])).toContain(OPEN.content);
    const writes = world.userForModel.filter((one) => one.turnIndex === 3);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.kept.snapshot).toMatchObject({ spaceId: "s1", full: true });
    expect(JSON.stringify(writes[1]?.kept.messages)).toContain(OPEN.content);
  });
});
