// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * However folds and continuations fall in a turn, every request the model
 * receives carries each tool call this turn made with its result, and no tool
 * runs twice (inner#1567, A2 and A3; design 6.4.4, the invariants in 6.6 and
 * the property in 8).
 *
 * The turn's shape is generated: any run of tool steps, steps whose count
 * leaves no room (a precheck fold follows, in `prepareStep`), and calls the
 * provider turns away as too long -- H1 as a first call or a later step, H1
 * wrapped in a `RetryError`, H2, and an overflow with no count (an overflow
 * fold and a continuation follow) -- with folds that end any way a fold can.
 * Whatever the shape:
 *
 * - request k holds, in order and once each, the call and the result of every
 *   tool call scripted before it: nothing finished is dropped, nothing is
 *   sent twice, and nothing is sent without its partner;
 * - `fetch_page` ran once per call the model made;
 * - the reply carries an error chunk only when it ends as failed, it ends as
 *   failed only after an overflow fold that touched nothing, it ends stopped
 *   only after a fold the reader stopped, and a turn that ended neither
 *   failed, too long nor stopped ends with its answer.
 *
 * The window is set above H2's 2,021,458 so every rejection kind can be
 * folded for and carried on from, and the keep line above the window so one
 * fold takes exactly one of the earlier turns.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  answers,
  callsFetch,
  h1,
  h1AfterRetry,
  h2,
  overflowWithoutCount,
  plainTurn,
  resetWorld,
  sendMessage,
  toolPairsOf,
  typesOf,
  world,
  type ScriptedCall,
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

const WINDOW = 2_100_000;
/** The window less the 16,384 output reserve: a known count of this leaves no room. */
const LINE = WINDOW - 16_384;
const FOLD_LIMIT = 3;
/** More earlier turns than any generated turn can fold. */
const EARLIER_TURNS = 8;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T09:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

/** One call of the generated turn, before the answer that ends it. */
type Step =
  | { kind: "tool"; input: number; output: number }
  | { kind: "full" }
  | { kind: "overflow"; shape: "h1" | "h1-retried" | "h2" | "no-count" };

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("tool" as const), input: fc.integer({ min: 1, max: 5_000 }), output: fc.integer({ min: 0, max: 500 }) }),
  fc.constant<Step>({ kind: "full" }),
  fc.record({ kind: fc.constant("overflow" as const), shape: fc.constantFrom("h1" as const, "h1-retried" as const, "h2" as const, "no-count" as const) }),
);

const outcomeArbitrary: fc.Arbitrary<World["foldOutcomes"][number]> = fc.constantFrom(
  "written" as const,
  "written" as const,
  "discarded" as const,
  "superseded" as const,
  "untouched" as const,
  "aborted" as const,
);

/**
 * The rejection an overflow step is turned away with.
 * @param shape - Which one.
 * @returns The error.
 */
function rejection(shape: Extract<Step, { kind: "overflow" }>["shape"]): unknown {
  if (shape === "h1") return h1();
  if (shape === "h1-retried") return h1AfterRetry();
  if (shape === "h2") return h2();
  return overflowWithoutCount();
}

/**
 * The model's calls for a generated turn.
 * @param steps - The generated steps.
 * @returns The script, ending on an answer.
 */
function scriptOf(steps: readonly Step[]): ScriptedCall[] {
  return [
    ...steps.map((step, i): ScriptedCall => {
      if (step.kind === "overflow") return { reject: rejection(step.shape) };
      if (step.kind === "full") return callsFetch(`c${String(i)}`, LINE, 0);
      return callsFetch(`c${String(i)}`, step.input, step.output);
    }),
    answers("done", 70, 7),
  ];
}

/**
 * The tool call a scripted call makes, if it makes one.
 * @param call - The call.
 * @returns Its call id, or undefined.
 */
function toolCallOf(call: ScriptedCall): string | undefined {
  if ("reject" in call) return undefined;
  const part = call.parts.find((one) => one.type === "tool-call");
  return part?.type === "tool-call" ? part.toolCallId : undefined;
}

describe("tool calls across folds and continuations", () => {
  it("go to every request paired with their results, and each tool runs once per call", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArbitrary, { maxLength: 6 }),
        fc.array(outcomeArbitrary, { minLength: 6, maxLength: 6 }),
        async (steps, outcomes) => {
          resetWorld();
          world.window = WINDOW;
          world.config.memory_keep_tokens = 3_000_000;
          world.config.overflow_folds_per_turn = FOLD_LIMIT;
          world.config.max_tool_iterations = 20;
          world.history = Array.from({ length: EARLIER_TURNS }, (_, i) => plainTurn(i + 1, 10_000)).flat();
          world.nextTurn = EARLIER_TURNS + 1;
          const script = scriptOf(steps);
          world.script = [...script];
          world.foldOutcomes = [...outcomes];

          const chunks = await sendMessage();

          // Request k is the k-th scripted call; every tool call scripted
          // before it ran, so it goes back with its result.
          for (const [k, prompt] of world.prompts.entries()) {
            const ran = script.slice(0, k).flatMap((call) => toolCallOf(call) ?? []);
            expect(toolPairsOf(prompt)).toEqual({ calls: ran, results: ran });
          }
          const made = script.slice(0, script.length - world.script.length);
          expect(world.toolRuns).toBe(made.filter((call) => toolCallOf(call) !== undefined).length);

          const parts = world.replies.at(-1)?.message.parts ?? [];
          const failed = parts.filter((part) => part.type === "failed");
          const errors = typesOf(chunks).filter((type) => type === "error").length;
          const plainFailure = failed.length === 1 && !("reason" in failed[0]! && failed[0].reason !== undefined);
          expect(errors).toBe(plainFailure ? 1 : 0);
          // Nothing generated here fails a turn but an overflow fold that
          // touched nothing, and nothing stops one but a fold the reader
          // stopped (the state table in 6.6).
          const endedFolds = outcomes.slice(0, world.folds.length);
          const interrupted = parts.some((part) => part.type === "interrupted");
          if (!endedFolds.includes("untouched")) expect(plainFailure).toBe(false);
          if (!endedFolds.includes("aborted")) expect(interrupted).toBe(false);
          if (failed.length === 0 && !interrupted) {
            expect(world.script).toHaveLength(0);
            expect(parts).toContainEqual({ type: "text", text: "done" });
          }
        },
      ),
      { numRuns: 80 },
    );
  });
});
