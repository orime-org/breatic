// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A call the provider turns away as over its context window is folded for
 * and carried on, inside the same reply (inner#1567, A2, A3, A5; design 6.4
 * and the state table in 6.6).
 *
 * The rejections are H1 and H2 verbatim: what OpenRouter returned on
 * 2026-10-25 for a first request and for a second step after a tool ran.
 * Neither carries usage, and the step it ends has no output, so what the
 * reader sees is one reply: the waiting dot, "consolidating memory", and the
 * answer -- never the error.
 *
 * Window 1,048,576 (the probe's), output reserve 16,384, keep line 2,000,000,
 * memory reserve 4,000: the target a fold runs down to is
 * min(2,000,000, 1,032,192) - 4,000 = 1,028,192, so a
 * 30,000-character turn is one fold's worth against H1's 1,048,577.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import {
  PROBE_WINDOW,
  answers,
  asks,
  callsFetch,
  finish,
  h1,
  h1AfterRetry,
  h2,
  overflowWithoutCount,
  plainTurn,
  resetWorld,
  sendMessage,
  systemOf,
  thinksThenAnswers,
  toolPairsOf,
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
 * Earlier turns of the conversation, one per index, each of a given size.
 * @param count - How many.
 * @param size - Characters in each reply.
 * @throws {never} Never.
 */
function history(count: number, size: number): void {
  world.history = Array.from({ length: count }, (_, i) => plainTurn(i + 1, size)).flat();
  world.nextTurn = count + 1;
}

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
 * The parts of the reply the turn stored.
 * @returns Its parts.
 */
function stored(): Array<{ type: string; [key: string]: unknown }> {
  return (world.replies.at(-1)?.message.parts ?? []);
}

/**
 * How many times the turn read its context.
 * @returns The count.
 */
function contextReads(): number {
  return world.events.filter((e) => e === "context").length;
}

describe("a first call over the window (A2)", () => {
  it("folds, then answers in the same reply without showing the error", async () => {
    history(2, 30_000);
    world.script = [{ reject: h1() }, thinksThenAnswers("the answer")];

    const chunks = await sendMessage();

    expect(world.events.filter((e) => e !== "context")).toEqual(["call", "fold", "call"]);
    expect(world.folds.map((f) => f.newWatermark)).toEqual([1]);
    expect(count(chunks, "error")).toBe(0);
    expect(count(chunks, "start")).toBe(1);
    expect(count(chunks, "data-memory-consolidating")).toBe(1);
    expect(chunks).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "the answer" }));
    expect(stored()).toContainEqual({ type: "text", text: "the answer" });
    expect(stored().some((part) => part.type === "failed")).toBe(false);
  });

  it("sends the reassembled request: the new memory in, the folded turn out", async () => {
    history(2, 30_000);
    world.script = [{ reject: h1() }, answers("the answer")];

    await sendMessage();

    const resent = world.prompts[1] ?? [];
    expect(systemOf(resent)).toContain("## Conversation Memory\nMEMORY-THROUGH-1");
    expect(JSON.stringify(resent)).not.toContain("TURN-1-REPLY");
    expect(JSON.stringify(resent)).toContain("TURN-2-REPLY");
  });

  it("recognises the overflow when the SDK wrapped it in a RetryError", async () => {
    history(2, 30_000);
    world.script = [{ reject: h1AfterRetry() }, answers("the answer")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(count(chunks, "error")).toBe(0);
    expect(stored()).toContainEqual({ type: "text", text: "the answer" });
  });
});

describe("a second step over the window after a tool ran (A3)", () => {
  /**
   * The H2 shape: a tool call that reported usage, then a rejected step.
   * @throws {never} Never.
   */
  function h2Turn(): void {
    // Turn 1 alone is big enough that taking it brings H2's 2,021,458 under
    // the window; anything smaller and the reply ends as too long instead.
    world.history = [...plainTurn(1, 1_000_000), ...plainTurn(2, 100)];
    world.nextTurn = 3;
  }

  it("folds and carries on: the tool ran once and its call and result go back as a pair", async () => {
    h2Turn();
    world.script = [callsFetch("c1", 311, 50), { reject: h2() }, answers("one word")];

    const chunks = await sendMessage();

    expect(world.toolRuns).toBe(1);
    expect(world.folds.map((f) => f.newWatermark)).toEqual([1]);
    expect(world.prompts).toHaveLength(3);
    expect(toolPairsOf(world.prompts[2] ?? [])).toEqual({ calls: ["c1"], results: ["c1"] });
    expect(count(chunks, "error")).toBe(0);
    expect(count(chunks, "start")).toBe(1);
    expect(stored()).toContainEqual(expect.objectContaining({ type: "tool", toolCallId: "c1", status: "success" }));
    expect(stored()).toContainEqual({ type: "text", text: "one word" });
    expect(stored().some((part) => part.type === "failed")).toBe(false);
  });

  it("counts the steps of every stream against one max_tool_iterations", async () => {
    h2Turn();
    world.config.max_tool_iterations = 3;
    world.script = [
      callsFetch("c1", 311, 50),
      { reject: h2() },
      callsFetch("c2", 311, 50),
      callsFetch("c3", 311, 50),
      answers("never asked for"),
    ];

    await sendMessage();

    // Three steps produced output; the rejected one is not a step.
    expect(world.toolRuns).toBe(3);
    expect(world.prompts).toHaveLength(4);
    expect(world.script).toHaveLength(1);
  });

  it("says how long it thought once, on the stream that ends the turn", async () => {
    h2Turn();
    world.script = [callsFetch("c1", 311, 50, true), { reject: h2() }, thinksThenAnswers("one word")];

    const chunks = await sendMessage();

    expect(stored()).toContainEqual({ type: "text", text: "one word" });
    expect(count(chunks, "data-thinking-time")).toBe(1);
    expect(stored().filter((part) => part.type === "thinking-time")).toHaveLength(1);
  });

  it("marks a truncated answer once", async () => {
    h2Turn();
    world.script = [
      callsFetch("c1", 311, 50),
      { reject: h2() },
      {
        parts: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "cut off mid" },
          { type: "text-end", id: "t1" },
          finish("length", 100, 10),
        ],
      },
    ];

    const chunks = await sendMessage();

    expect(count(chunks, "data-truncated")).toBe(1);
    expect(stored().filter((part) => part.type === "truncated")).toHaveLength(1);
  });

  it("stops at a questionnaire once", async () => {
    h2Turn();
    world.script = [callsFetch("c1", 311, 50), { reject: h2() }, asks("ask-1")];

    const chunks = await sendMessage();

    expect(count(chunks, "data-ask-awaiting")).toBe(1);
    expect(stored()).toContainEqual(expect.objectContaining({ type: "tool", toolCallId: "ask-1", status: "awaiting" }));
  });
});

describe("a turn that cannot be made to fit ends as too long (A5)", () => {
  /**
   * What a too-long ending must look like, live and stored.
   * @param chunks - The turn's chunks.
   * @throws {never} Never.
   */
  function expectTooLong(chunks: readonly UIMessageChunk[]): void {
    expect(chunks).toContainEqual({ type: "data-failed", data: { reason: "too_long" } });
    expect(count(chunks, "error")).toBe(0);
    expect(stored().filter((part) => part.type === "failed")).toEqual([{ type: "failed", reason: "too_long" }]);
  }

  it("after overflow_folds_per_turn folds", async () => {
    history(4, 30_000);
    world.script = [{ reject: h1() }, { reject: h1() }, { reject: h1() }, answers("never asked for")];

    const chunks = await sendMessage();

    expect(world.folds.map((f) => f.newWatermark)).toEqual([1, 2]);
    expect(world.prompts).toHaveLength(3);
    expectTooLong(chunks);
  });

  it("when there is no earlier turn to take", async () => {
    world.script = [{ reject: overflowWithoutCount() }, answers("never asked for")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(0);
    expect(world.prompts).toHaveLength(1);
    expectTooLong(chunks);
  });

  it("without folding when the reported count less everything takeable is still over the window", async () => {
    // H2's 2,021,458 less one small earlier turn is far over 1,032,192: a fold
    // would be paid for and could not make the request fit.
    history(1, 1_000);
    world.script = [callsFetch("c1", 311, 50), { reject: h2() }, answers("never asked for")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(0);
    expect(world.toolRuns).toBe(1);
    expect(world.prompts).toHaveLength(2);
    expectTooLong(chunks);
  });

  it("says how long it thought before it ended, live as well as stored", async () => {
    history(1, 1_000);
    world.script = [callsFetch("c1", 311, 50, true), { reject: h2() }, answers("never asked for")];

    const chunks = await sendMessage();

    expectTooLong(chunks);
    const said = chunks.filter((chunk) => chunk.type === "data-thinking-time");
    expect(said).toHaveLength(1);
    expect((said[0] as { data: { ms: number } }).data.ms).toBeGreaterThan(0);
    expect(typesOf(chunks).indexOf("data-thinking-time")).toBeLessThan(typesOf(chunks).indexOf("data-failed"));
    expect(stored().filter((part) => part.type === "thinking-time")).toHaveLength(1);
  });
});

describe("folds that leave nothing to send end as failed (A5)", () => {
  /**
   * What an ordinary failure looks like, live and stored.
   * @param chunks - The turn's chunks.
   * @throws {never} Never.
   */
  function expectFailed(chunks: readonly UIMessageChunk[]): void {
    expect(count(chunks, "error")).toBe(1);
    expect(stored().filter((part) => part.type === "failed")).toEqual([{ type: "failed" }]);
  }

  it("an overflow fold that touched nothing does not resend the rejected request", async () => {
    history(2, 30_000);
    world.foldOutcomes = ["untouched"];
    world.script = [{ reject: h1() }, answers("never asked for")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(world.prompts).toHaveLength(1);
    expectFailed(chunks);
  });

  it("a reassembly that throws after an overflow fold does not resend the rejected request", async () => {
    history(2, 30_000);
    world.failReadsAfter = 1;
    world.script = [{ reject: h1() }, answers("never asked for")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(world.prompts).toHaveLength(1);
    expectFailed(chunks);
  });

  it.each([
    ["an overflow fold that touched nothing", (): void => {
      world.foldOutcomes = ["untouched"];
    }],
    ["a reassembly that throws after an overflow fold", (): void => {
      world.failReadsAfter = 1;
    }],
  ])("says how long it thought, live, when %s ends the turn as failed", async (_name, arrange) => {
    history(2, 30_000);
    arrange();
    world.script = [callsFetch("c1", 311, 50, true), { reject: h1() }, answers("never asked for")];

    const chunks = await sendMessage();

    expectFailed(chunks);
    expect(count(chunks, "data-thinking-time")).toBe(1);
    expect(stored().filter((part) => part.type === "thinking-time")).toHaveLength(1);
  });

  it("a reassembly that throws after a precheck fold sends nothing more", async () => {
    world.window = 200_000;
    history(3, 10_000);
    world.failReadsAfter = 1;
    world.script = [callsFetch("c1", 183_616, 0), answers("never asked for")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(world.prompts).toHaveLength(1);
    expectFailed(chunks);
  });
});

describe("a precheck fold that touched nothing (A5)", () => {
  it("sends the request as it stands and answers", async () => {
    world.window = 200_000;
    history(3, 10_000);
    world.foldOutcomes = ["untouched"];
    world.script = [callsFetch("c1", 183_616, 0), answers("done")];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(world.prompts).toHaveLength(2);
    expect(contextReads()).toBe(1);
    expect(count(chunks, "error")).toBe(0);
    expect(stored()).toContainEqual({ type: "text", text: "done" });
  });
});

describe("the reader stopping during a fold", () => {
  it.each([
    ["an overflow fold", (): void => {
      history(2, 30_000);
      world.script = [{ reject: h1() }, answers("never asked for")];
    }],
    ["a precheck fold", (): void => {
      world.window = 200_000;
      history(3, 10_000);
      world.script = [callsFetch("c1", 183_616, 0), answers("never asked for")];
    }],
  ])("ends %s as stopped, without reassembling or calling again", async (_name, arrange) => {
    arrange();
    world.foldOutcomes = ["aborted"];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(world.prompts).toHaveLength(1);
    expect(contextReads()).toBe(1);
    expect(world.watermark).toBe(0);
    expect(count(chunks, "error")).toBe(0);
    expect(stored()).toContainEqual({ type: "interrupted" });
  });

  it("does not say how long it thought live when the reader stops an overflow fold, as on any stop", async () => {
    history(2, 30_000);
    world.foldOutcomes = ["aborted"];
    world.script = [callsFetch("c1", 311, 50, true), { reject: h1() }, answers("never asked for")];

    const chunks = await sendMessage();

    expect(count(chunks, "data-thinking-time")).toBe(0);
    expect(stored().filter((part) => part.type === "thinking-time")).toHaveLength(1);
  });
});

describe("another tab folding first", () => {
  it.each([
    ["an overflow fold", (): void => {
      history(2, 30_000);
      world.script = [{ reject: h1() }, answers("after the other tab")];
    }],
    ["a precheck fold", (): void => {
      world.window = 200_000;
      history(3, 10_000);
      world.script = [callsFetch("c1", 183_616, 0), answers("after the other tab")];
    }],
  ])("reassembles after %s that was superseded and carries on", async (_name, arrange) => {
    arrange();
    world.foldOutcomes = ["superseded"];

    const chunks = await sendMessage();

    expect(world.folds).toHaveLength(1);
    expect(contextReads()).toBe(2);
    expect(world.prompts).toHaveLength(2);
    expect(systemOf(world.prompts[1])).toContain("## Conversation Memory\nMEMORY-THROUGH-1");
    expect(count(chunks, "error")).toBe(0);
    expect(stored()).toContainEqual({ type: "text", text: "after the other tab" });
  });
});
