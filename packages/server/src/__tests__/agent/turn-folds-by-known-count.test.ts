// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn folds before a call only when the provider's own count says the
 * request no longer fits (inner#1567, A1 and A3; design 6.2).
 *
 * Remaining room is the main model's window less `max_output_tokens` less the
 * known count, which is what the provider reported for the previous call:
 * input plus output. At or under zero the turn folds before it sends. At the
 * start of a turn the known count is the newest reply row's, and only when the
 * provider reported it and the request it measured is still the prefix this
 * turn replays. Inside a turn it is the previous step's, and a fold voids it
 * until the next call reports again.
 *
 * The window here is 200,000 and the output reserve 16,384, so the line is a
 * known count of 183,616. Every "does not fold" case runs its positive twin in
 * the same test, so it cannot pass on a turn that never folds at all.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageData } from "@breatic/shared";
import {
  answers,
  asks,
  callsFetch,
  overflowWithoutCount,
  plainTurn,
  resetWorld,
  rowsOf,
  sendMessage,
  systemOf,
  toolPairsOf,
  world,
  type ScriptedCall,
} from "../helpers/overflow-turn.js";
import { askResultForModel } from "@server/agent/ask-result.js";
import { logger } from "@breatic/core";

vi.mock("@breatic/core", async (importOriginal) => (await import("../helpers/overflow-turn.js")).overflowCore(importOriginal));
vi.mock("@breatic/domain", async () => (await import("../helpers/overflow-turn.js")).overflowDomain());
vi.mock("@server/modules", async (importOriginal) => (await import("../helpers/mock-core.js")).serverModulesMock(importOriginal));
vi.mock("@server/modules/conversation/conversation-message.repo.js", async () => (await import("../helpers/overflow-turn.js")).overflowRepo());
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ titleForTurn: async () => null }));
vi.mock("@server/agent/turn-context.js", async () => (await import("../helpers/overflow-turn.js")).overflowTurnContext());
vi.mock("@server/agent/memory-consolidator.js", async () => (await import("../helpers/overflow-turn.js")).overflowConsolidator());
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

const WINDOW = 200_000;
/** The known count that leaves exactly no room: 200,000 - 16,384. */
const LINE = 183_616;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T09:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  resetWorld();
  world.window = WINDOW;
});

type Rows = Array<MessageData & { forModel: unknown }>;

/**
 * Run a first turn, read back what it stored, and run the next turn on it.
 * @param first - What the model does in the first turn.
 * @param options - How the stored rows or the conversation change in between.
 * @param options.edit - Change the rows the first turn left.
 * @param options.memory - The conversation memory the second turn reads.
 * @param options.stopDuringTool - The reader stops the first turn while its tool runs.
 * @returns How many folds the second turn ran, and what it sent first.
 */
async function nextTurnAfter(
  first: ScriptedCall[],
  options: { edit?: (rows: Rows) => void; memory?: string; stopDuringTool?: boolean } = {},
): Promise<{ folds: number; watermarks: number[]; firstSystem: string; foldedBeforeFirstCall: boolean }> {
  resetWorld();
  world.window = WINDOW;
  world.script = first;
  if (options.stopDuringTool === true) world.duringTool = () => world.controller.abort();
  await sendMessage("first");
  const rows = rowsOf(1);
  options.edit?.(rows);
  world.history = rows;
  world.controller = new AbortController();
  world.duringTool = undefined;
  if (options.memory !== undefined) world.memory = options.memory;
  const foldsBefore = world.folds.length;
  const eventsBefore = world.events.length;
  const promptsBefore = world.prompts.length;
  world.script = [answers("second")];
  await sendMessage("second");
  const ofThisTurn = world.events.slice(eventsBefore);
  return {
    folds: world.folds.length - foldsBefore,
    watermarks: world.folds.slice(foldsBefore).map((f) => f.newWatermark as number),
    firstSystem: systemOf(world.prompts[promptsBefore]),
    foldedBeforeFirstCall: ofThisTurn.indexOf("fold") !== -1 && ofThisTurn.indexOf("fold") < ofThisTurn.indexOf("call"),
  };
}

/**
 * The reply row of the first turn.
 * @param rows - The first turn's rows.
 * @returns What it kept for the model.
 * @throws {Error} When there is no reply row.
 */
function replyKept(rows: Rows): Record<string, unknown> {
  const reply = rows.find((row) => row.role === "assistant");
  if (reply === undefined) throw new Error("the first turn stored no reply");
  return reply.forModel as Record<string, unknown>;
}

describe("at the start of a turn", () => {
  it("folds before the first call when the newest reply's provider count leaves no room, and sends the reassembled request", async () => {
    const turn = await nextTurnAfter([answers("first answer", LINE - 616, 616)]);

    expect(turn.folds).toBe(1);
    expect(turn.foldedBeforeFirstCall).toBe(true);
    expect(turn.watermarks).toEqual([1]);
    expect(turn.firstSystem).toContain("## Conversation Memory\nMEMORY-THROUGH-1");
  });

  it("sizes an overflow of the first call by the newest reply's provider count", async () => {
    // Room is left, so nothing folds before the call; the provider then turns
    // it away without saying how big it was.
    world.script = [answers("first answer", LINE - 1_000, 10)];
    await sendMessage("first");
    world.history = rowsOf(1);
    world.script = [{ reject: overflowWithoutCount() }, answers("second")];
    vi.mocked(logger.warn).mockClear();

    await sendMessage("second");

    expect(world.folds).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ known: LINE - 990, attempt: 1 }), "agent_fold_on_overflow");
  });

  it("does not try a fold that could not run again before the first call", async () => {
    world.script = [answers("first answer", LINE - 616, 616)];
    await sendMessage("first");
    world.history = rowsOf(1);
    world.foldOutcomes = ["untouched"];
    world.script = [answers("second")];

    await sendMessage("second");

    expect(world.folds).toHaveLength(1);
    expect(world.events.filter((e) => e !== "context").slice(-2)).toEqual(["fold", "call"]);
  });

  it("trusts the count of a reply whose turn folded before it called", async () => {
    world.script = [answers("first answer", LINE - 616, 616)];
    await sendMessage("first");
    world.history = rowsOf(1);
    world.script = [answers("second answer", LINE - 616, 616)];
    await sendMessage("second");
    world.history = [...rowsOf(1), ...rowsOf(2)];
    world.script = [answers("third")];

    await sendMessage("third");

    expect(world.folds.map((f) => f.newWatermark)).toEqual([1, 2]);
  });

  it("hands the fold its turns as ordered groups", async () => {
    await nextTurnAfter([answers("first answer", LINE - 616, 616)]);

    const groups = world.folds[0]?.turns as Array<{ turnIndex: number; messages: unknown[] }> | undefined;
    expect(groups?.map((group) => group.turnIndex)).toEqual([1]);
    expect(JSON.stringify(groups?.[0]?.messages)).toContain("first answer");
  });

  it("sends as is while one token of room is left, and folds at none", async () => {
    const roomLeft = await nextTurnAfter([answers("first answer", LINE - 615, 614)]);
    const noRoom = await nextTurnAfter([answers("first answer", LINE - 615, 615)]);

    expect(roomLeft.folds).toBe(0);
    expect(noRoom.folds).toBe(1);
  });

  it("does not check a newest row whose count is a character fallback", async () => {
    const fallback = await nextTurnAfter([answers("first answer", LINE, 10)], {
      edit: (rows) => {
        replyKept(rows).endTokensFrom = "chars";
      },
    });
    const reported = await nextTurnAfter([answers("first answer", LINE, 10)]);

    expect(fallback.folds).toBe(0);
    expect(reported.folds).toBe(1);
  });

  it("does not check a newest row stored before counts had a source", async () => {
    const legacy = await nextTurnAfter([answers("first answer", LINE, 10)], {
      edit: (rows) => {
        delete replyKept(rows).endTokensFrom;
      },
    });
    const reported = await nextTurnAfter([answers("first answer", LINE, 10)]);

    expect(legacy.folds).toBe(0);
    expect(reported.folds).toBe(1);
  });

  it("does not check a count whose request no longer matches the prefix this turn replays", async () => {
    // The memory changed since, so the system prompt the count measured is gone.
    const changed = await nextTurnAfter([answers("first answer", LINE, 10)], { memory: "remembered since" });
    const same = await nextTurnAfter([answers("first answer", LINE, 10)]);

    expect(changed.folds).toBe(0);
    expect(same.folds).toBe(1);
  });

  it("reads the count of a newest row that stopped at a questionnaire", async () => {
    const turn = await nextTurnAfter([asks("ask-1", LINE, 10)], {
      edit: (rows) => {
        // The reader wrote a message instead of answering; the repository
        // settles the card in the row that asked.
        const kept = replyKept(rows) as { messages: unknown[] };
        kept.messages.push(askResultForModel("ask-1", { repliedInChat: true }));
      },
    });

    expect(turn.folds).toBe(1);
    expect(turn.foldedBeforeFirstCall).toBe(true);
  });

  it("reads the count of a newest row the reader stopped after its call reported", async () => {
    const turn = await nextTurnAfter([callsFetch("c1", LINE, 10)], { stopDuringTool: true });

    expect(world.replies[0]?.message.parts).toContainEqual({ type: "interrupted" });
    expect(turn.folds).toBe(1);
    expect(turn.foldedBeforeFirstCall).toBe(true);
  });

  it("reads the count of a newest row that failed after its last call reported", async () => {
    const turn = await nextTurnAfter([
      {
        parts: [
          ...(answers("half an answer", LINE, 10) as { parts: never[] }).parts,
          { type: "error", error: new Error("upstream reset the connection") },
        ],
      },
    ]);

    expect(world.replies[0]?.message.parts).toContainEqual(expect.objectContaining({ type: "failed" }));
    expect(turn.folds).toBe(1);
    expect(turn.foldedBeforeFirstCall).toBe(true);
  });
});

describe("in the middle of a turn", () => {
  beforeEach(() => {
    // Three earlier turns, each big enough that one fold takes one of them.
    world.history = [...plainTurn(1, 10_000), ...plainTurn(2, 10_000), ...plainTurn(3, 10_000)];
    world.nextTurn = 4;
  });

  it("folds before the next call when the previous call reported input and output with no room left", async () => {
    world.script = [callsFetch("c1", LINE - 600, 600), answers("done")];

    await sendMessage();

    expect(world.events.filter((e) => e !== "context")).toEqual(["call", "tool", "fold", "call"]);
    expect(world.toolRuns).toBe(1);
    expect(systemOf(world.prompts[1])).toContain("## Conversation Memory\nMEMORY-THROUGH-1");
    expect(toolPairsOf(world.prompts[1] ?? [])).toEqual({ calls: ["c1"], results: ["c1"] });
    const stored = world.replies.at(-1)?.message.parts ?? [];
    expect(stored).toContainEqual({ type: "text", text: "done" });
    expect(stored.some((part) => part.type === "failed")).toBe(false);
  });

  it("sends the next call as is while one token of room is left", async () => {
    world.script = [callsFetch("c1", LINE - 600, 599), answers("done")];
    const history = world.history;
    await sendMessage();
    const roomLeft = world.folds.length;

    resetWorld();
    world.window = WINDOW;
    world.history = history;
    world.nextTurn = 4;
    world.script = [callsFetch("c1", LINE - 600, 600), answers("done")];
    await sendMessage();

    expect(roomLeft).toBe(0);
    expect(world.folds).toHaveLength(1);
  });

  it("does not check the call right after a fold again, and checks the one after it", async () => {
    // Both tool calls report over the line. The fold voids the first count, so
    // the second call goes without a second fold in front of it; its own count
    // then folds again before the third.
    world.script = [callsFetch("c1", LINE, 10), callsFetch("c2", LINE, 10), answers("done")];

    await sendMessage();

    expect(world.events.filter((e) => e !== "context")).toEqual(["call", "tool", "fold", "call", "tool", "fold", "call"]);
    expect(world.folds.map((f) => f.watermarkBefore)).toEqual([0, 1]);
    expect(toolPairsOf(world.prompts[2] ?? [])).toEqual({ calls: ["c1", "c2"], results: ["c1", "c2"] });
  });
});
