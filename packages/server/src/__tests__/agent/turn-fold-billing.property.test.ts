// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * However folds and continuations fall in a turn, what is charged matches
 * the calls that ran (inner#1567, A7; design 6.8, invariants in 6.6).
 *
 * Credit deduction is a critical path, so the turn's shape is generated: any
 * run of tool steps, steps whose count leaves no room (a precheck fold
 * follows), calls the provider turns away as too long (an overflow fold and a
 * continuation follow), and folds the reader stops. Whatever the shape:
 *
 * - every call that reported usage is recorded once, and nothing else is;
 * - the turn is charged once, for exactly what those calls reported, so a
 *   rejected call costs nothing;
 * - every fold starts from a different watermark, so each has its own refKey
 *   (`consolidate:${conversationId}:${watermarkBefore}`) and none is refused
 *   as a duplicate;
 * - a turn nobody stopped, within its fold limit, ends with its answer.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  answers,
  callsFetch,
  overflowWithoutCount,
  plainTurn,
  resetWorld,
  sendMessage,
  world,
  type ScriptedCall,
} from "../helpers/overflow-turn.js";

vi.mock("@breatic/core", async (importOriginal) => (await import("../helpers/overflow-turn.js")).overflowCore(importOriginal));
vi.mock("@breatic/domain", async () => (await import("../helpers/overflow-turn.js")).overflowDomain());
vi.mock("@server/modules", async (importOriginal) => (await import("../helpers/mock-core.js")).serverModulesMock(importOriginal));
vi.mock("@server/modules/conversation/conversation-message.repo.js", async () => (await import("../helpers/overflow-turn.js")).overflowRepo());
vi.mock("@server/modules/conversation/conversation.service.js", () => ({ titleForTurn: async () => null }));
vi.mock("@server/agent/turn-context.js", async () => (await import("../helpers/overflow-turn.js")).overflowTurnContext());
vi.mock("@server/agent/memory-consolidator.js", async () => (await import("../helpers/overflow-turn.js")).overflowConsolidator());
vi.mock("@server/agent/context.js", () => ({ buildSystemPrompt: () => "system" }));

/** Window 200,000 less the 16,384 output reserve: a known count of this leaves no room. */
const LINE = 183_616;
const FOLD_LIMIT = 3;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T09:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

/** One call of the generated turn, before the answer that ends it. */
type Step = { kind: "tool"; input: number; output: number } | { kind: "full" } | { kind: "overflow" };

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("tool" as const), input: fc.integer({ min: 1, max: 5_000 }), output: fc.integer({ min: 0, max: 500 }) }),
  fc.constant<Step>({ kind: "full" }),
  fc.constant<Step>({ kind: "overflow" }),
);

/**
 * The model's calls for a generated turn.
 * @param steps - The generated steps.
 * @returns The script, ending on an answer.
 */
function scriptOf(steps: readonly Step[]): ScriptedCall[] {
  return [
    ...steps.map((step, i): ScriptedCall => {
      if (step.kind === "overflow") return { reject: overflowWithoutCount() };
      if (step.kind === "full") return callsFetch(`c${String(i)}`, LINE, 0);
      return callsFetch(`c${String(i)}`, step.input, step.output);
    }),
    answers("done", 70, 7),
  ];
}

/**
 * What a scripted call reports, when it reports anything.
 * @param call - The call.
 * @returns Input plus output, or undefined for a rejected call.
 */
function reported(call: ScriptedCall): number | undefined {
  if ("reject" in call) return undefined;
  const end = call.parts.find((part) => part.type === "finish");
  if (end?.type !== "finish") return undefined;
  return (end.usage.inputTokens.total ?? 0) + (end.usage.outputTokens.total ?? 0);
}

describe("charging a turn that folds and continues", () => {
  it("records and charges exactly the calls that reported usage, and gives every fold its own refKey", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArbitrary, { maxLength: 5 }),
        fc.array(fc.constantFrom("written" as const, "written" as const, "written" as const, "aborted" as const), { minLength: 6, maxLength: 6 }),
        async (steps, outcomes) => {
          resetWorld();
          world.window = 200_000;
          world.config.overflow_folds_per_turn = FOLD_LIMIT;
          world.config.max_tool_iterations = 10;
          // Eight earlier turns: every fold, of either kind, takes one of them.
          world.history = Array.from({ length: 8 }, (_, i) => plainTurn(i + 1, 10_000)).flat();
          world.nextTurn = 9;
          const script = scriptOf(steps);
          world.script = [...script];
          world.foldOutcomes = [...outcomes];

          await sendMessage();

          const made = script.slice(0, world.prompts.length);
          const accepted = made.flatMap((call) => {
            const n = reported(call);
            return n === undefined ? [] : [n];
          });
          const turnRecords = world.recorded.filter((one) => one.key === "turn:c1:9");
          expect(turnRecords).toHaveLength(accepted.length);

          const owed = accepted.reduce((sum, n) => sum + n, 0);
          const turnCharges = world.charges.filter((one) => one.key === "turn:c1:9");
          expect(turnCharges).toEqual(owed === 0 ? [] : [{ key: "turn:c1:9", amount: owed }]);

          const keys = world.folds.map((fold) => `consolidate:c1:${String(fold.watermarkBefore)}`);
          expect(new Set(keys).size).toBe(keys.length);

          const stopped = outcomes.slice(0, world.folds.length).includes("aborted");
          const overflows = steps.filter((step) => step.kind === "overflow").length;
          if (!stopped && overflows <= FOLD_LIMIT) {
            expect(world.prompts).toHaveLength(script.length);
            const parts = world.replies.at(-1)?.message.parts ?? [];
            expect(parts).toContainEqual({ type: "text", text: "done" });
            expect(parts.some((part) => part.type === "failed")).toBe(false);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
