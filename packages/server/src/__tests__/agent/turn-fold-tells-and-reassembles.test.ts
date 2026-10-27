// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the reader hears of a fold, what is sent after a fold that wrote
 * nothing, and a turn stopped before it asked anything (inner#1567, design
 * 6.4 and the state table in 6.6).
 *
 * - Every fold that starts tells the reader once (`data-memory-consolidating`);
 *   a turn that folds nothing says nothing of the sort.
 * - A fold that ends `discarded` moved the watermark without writing memory
 *   (event W), so the request in hand still carries the turns it passed: the
 *   turn reads everything again and sends that, whichever trigger folded.
 * - A reader who stopped before the first call is owed no paid work: no fold
 *   and no model call, even with a known count over the line.
 *
 * Window 200,000 and output reserve 16,384, so a known count of 183,616 leaves
 * no room, except where a case says otherwise.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  PROBE_WINDOW,
  answers,
  callsFetch,
  h1,
  plainTurn,
  resetWorld,
  rowsOf,
  sendMessage,
  systemOf,
  toolPairsOf,
  typesOf,
  world,
  type World,
} from "../helpers/overflow-turn.js";

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

/**
 * How many chunks of a type the turn put on the wire.
 * @param chunks - The turn's chunks.
 * @param type - The chunk type.
 * @returns The count.
 */
function count(chunks: readonly UIMessageChunk[], type: string): number {
  return typesOf(chunks).filter((t) => t === type).length;
}

/**
 * The parts of the reply the turn stored last.
 * @returns Its parts.
 */
function stored(): Array<{ type: string; [key: string]: unknown }> {
  return world.replies.at(-1)?.message.parts ?? [];
}

/** What the second of two turns did. */
interface SecondTurn {
  /** Its chunks. */
  chunks: UIMessageChunk[];
  /** What each of its model calls was handed. */
  prompts: unknown[][];
  /** How many folds it ran. */
  folds: number;
  /** How many times it read its context. */
  contextReads: number;
  /** The parts of the reply it stored. */
  reply: Array<{ type: string; [key: string]: unknown }>;
}

/**
 * Run a first turn whose answer reports a count, read back what it stored,
 * and run the next turn on it.
 * @param firstInput - Input tokens the first answer reports.
 * @param firstOutput - Output tokens the first answer reports.
 * @param options - How the second turn runs.
 * @param options.outcomes - How the second turn's folds end.
 * @param options.stopped - The reader stopped the second turn before it began.
 * @returns What the second turn did.
 */
async function secondTurn(
  firstInput: number,
  firstOutput: number,
  options: { outcomes?: World["foldOutcomes"]; stopped?: boolean } = {},
): Promise<SecondTurn> {
  resetWorld();
  world.window = WINDOW;
  world.script = [answers("first answer", firstInput, firstOutput)];
  await sendMessage("first");
  world.history = rowsOf(1);
  world.controller = new AbortController();
  if (options.stopped === true) world.controller.abort();
  world.foldOutcomes = [...(options.outcomes ?? [])];
  const foldsBefore = world.folds.length;
  const eventsBefore = world.events.length;
  const promptsBefore = world.prompts.length;
  world.script = [answers("second")];
  const chunks = await sendMessage("second");
  return {
    chunks,
    prompts: world.prompts.slice(promptsBefore),
    folds: world.folds.length - foldsBefore,
    contextReads: world.events.slice(eventsBefore).filter((e) => e === "context").length,
    reply: stored(),
  };
}

/**
 * Three earlier turns, each big enough that one fold takes one of them.
 * @throws {never} Never.
 */
function threeEarlierTurns(): void {
  world.history = [...plainTurn(1, 10_000), ...plainTurn(2, 10_000), ...plainTurn(3, 10_000)];
  world.nextTurn = 4;
}

describe("the reader is told of a precheck fold once", () => {
  it("at the start of a turn, and not on a turn with one token of room left", async () => {
    const folded = await secondTurn(LINE - 616, 616);
    const roomLeft = await secondTurn(LINE - 616, 615);

    expect(folded.folds).toBe(1);
    expect(count(folded.chunks, "data-memory-consolidating")).toBe(1);
    expect(roomLeft.folds).toBe(0);
    expect(count(roomLeft.chunks, "data-memory-consolidating")).toBe(0);
  });

  it("at the start of a turn, before the reply opens, so nothing clears the notice while the fold runs", async () => {
    resetWorld();
    world.window = WINDOW;
    world.script = [answers("first answer", LINE - 616, 616)];
    await sendMessage("first");
    world.history = rowsOf(1);
    let wireDuringFold: string[] = [];
    world.duringFold = async () => {
      // Long enough for anything already written to reach the reader.
      await new Promise((resolve) => setTimeout(resolve, 20));
      wireDuringFold = [...world.wire];
    };
    world.wire = [];
    world.script = [answers("second")];

    const chunks = await sendMessage("second");

    expect(wireDuringFold).toContain("data-memory-consolidating");
    expect(wireDuringFold).not.toContain("start");
    expect(typesOf(chunks).indexOf("data-memory-consolidating")).toBeLessThan(typesOf(chunks).indexOf("start"));
  });

  it("keeps the count coverage of a turn that folded only before it called", async () => {
    const turn = await secondTurn(LINE - 616, 616);

    expect(turn.folds).toBe(1);
    expect(world.replies.at(-1)?.forModel?.countCoverage).toMatchObject({ turnHash: expect.any(String), endHash: expect.any(String) });
  });

  it("in the middle of a turn, and not when the step left room", async () => {
    threeEarlierTurns();
    world.script = [callsFetch("c1", LINE - 600, 600), answers("done")];
    const folded = await sendMessage();
    const foldedFolds = world.folds.length;

    resetWorld();
    world.window = WINDOW;
    threeEarlierTurns();
    world.script = [callsFetch("c1", LINE - 600, 599), answers("done")];
    const roomLeft = await sendMessage();

    expect(foldedFolds).toBe(1);
    expect(count(folded, "data-memory-consolidating")).toBe(1);
    expect(world.folds).toHaveLength(0);
    expect(count(roomLeft, "data-memory-consolidating")).toBe(0);
    expect(stored()).toContainEqual({ type: "text", text: "done" });
  });

  it("once per fold when a turn folds twice", async () => {
    threeEarlierTurns();
    world.script = [callsFetch("c1", LINE, 10), callsFetch("c2", LINE, 10), answers("done")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(2);
    expect(count(chunks, "data-memory-consolidating")).toBe(2);
  });
});

describe("a fold that ended discarded is followed by a reassembly, and that is what is sent", () => {
  it("at the start of a turn", async () => {
    const turn = await secondTurn(LINE - 616, 616, { outcomes: ["discarded"] });

    expect(turn.folds).toBe(1);
    expect(turn.contextReads).toBe(2);
    expect(turn.prompts).toHaveLength(1);
    // The watermark passed turn 1 and no memory was written for it.
    expect(JSON.stringify(turn.prompts[0])).not.toContain("first answer");
    expect(systemOf(turn.prompts[0])).not.toContain("MEMORY-THROUGH");
    expect(count(turn.chunks, "error")).toBe(0);
    expect(turn.reply).toContainEqual({ type: "text", text: "second" });
  });

  it("in the middle of a turn, with the finished step carried over", async () => {
    threeEarlierTurns();
    world.foldOutcomes = ["discarded"];
    world.script = [callsFetch("c1", LINE, 0), answers("done")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(world.events.filter((e) => e === "context")).toHaveLength(2);
    expect(world.prompts).toHaveLength(2);
    const resent = JSON.stringify(world.prompts[1]);
    expect(resent).not.toContain("TURN-1-REPLY");
    expect(resent).toContain("TURN-2-REPLY");
    expect(systemOf(world.prompts[1])).not.toContain("MEMORY-THROUGH");
    expect(toolPairsOf(world.prompts[1] ?? [])).toEqual({ calls: ["c1"], results: ["c1"] });
    expect(world.toolRuns).toBe(1);
    expect(count(chunks, "error")).toBe(0);
    expect(stored()).toContainEqual({ type: "text", text: "done" });
  });

  it("after an overflow, carrying on in the same reply", async () => {
    world.window = PROBE_WINDOW;
    world.history = [...plainTurn(1, 30_000), ...plainTurn(2, 30_000)];
    world.nextTurn = 3;
    world.foldOutcomes = ["discarded"];
    world.script = [{ reject: h1() }, answers("the answer")];

    const chunks = await sendMessage();

    expect(world.events.filter((e) => e !== "context")).toEqual(["call", "fold", "call"]);
    expect(world.events.filter((e) => e === "context")).toHaveLength(2);
    const resent = JSON.stringify(world.prompts[1]);
    expect(resent).not.toContain("TURN-1-REPLY");
    expect(resent).toContain("TURN-2-REPLY");
    expect(count(chunks, "error")).toBe(0);
    expect(count(chunks, "start")).toBe(1);
    expect(stored()).toContainEqual({ type: "text", text: "the answer" });
    expect(stored().some((part) => part.type === "failed")).toBe(false);
  });
});

describe("a turn whose reader stopped before it began", () => {
  it("folds nothing and calls nothing, though its known count is over the line, and ends stopped", async () => {
    const stopped = await secondTurn(LINE - 616, 616, { stopped: true });
    const running = await secondTurn(LINE - 616, 616);

    expect(stopped.folds).toBe(0);
    expect(stopped.prompts).toHaveLength(0);
    expect(count(stopped.chunks, "data-memory-consolidating")).toBe(0);
    expect(stopped.chunks).toContainEqual({ type: "abort" });
    expect(count(stopped.chunks, "error")).toBe(0);
    expect(stopped.reply).toContainEqual({ type: "interrupted" });
    // The same turn not stopped does fold, so the case cannot pass on a turn
    // that would never have folded.
    expect(running.folds).toBe(1);
  });
});
