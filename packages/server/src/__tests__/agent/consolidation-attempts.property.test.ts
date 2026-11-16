// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One consolidation under any run of answers and any ending of its write
 * (#1363, critical path: AI tool call and credit deduction).
 *
 * Invariants, whatever the model answers and however the write ends:
 * - memory and the watermark are written at most once, and only with an
 *   answer that passed its checks;
 * - nothing is written once an answer was cut off, a call failed or the
 *   attempts ran out;
 * - every call that came back is charged once, under a key no other call
 *   shares, of the same fold or of any other fold, from the same watermark or
 *   not.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import type * as CoreModule from "@breatic/core";
import type * as DomainModule from "@breatic/domain";

const ATTEMPTS = 3;
const generateTextRetry = vi.fn();
const chargeOnce = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const commitConsolidation = vi.fn<(...args: unknown[]) => Promise<"written" | "superseded">>();
const consolidationInput = vi.fn(async () => ({ full: [], titlesOnly: [], progress: "" }));

vi.mock("@breatic/core", async (importOriginal) => {
  const { coreMock } = await import("../helpers/mock-core.js");
  const base = await coreMock(importOriginal);
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...base,
    runWithContext: actual.runWithContext,
    getContext: actual.getContext,
    getAgentConfig: () => ({
      ...(base.getAgentConfig as () => Record<string, unknown>)(),
      consolidation_answer_attempts: ATTEMPTS,
      consolidation_max_operations: 50,
      memory_progress_max_chars: 2000,
      consolidation_entries_max_chars: 60000,
    }),
  };
});

vi.mock("@breatic/domain", async (importOriginal) => {
  const { domainMock } = await import("../helpers/mock-core.js");
  const base = await domainMock();
  const actual = await importOriginal<typeof DomainModule>();
  return {
    ...base,
    generateTextRetry,
    provider: (await import("../helpers/fake-provider.js")).fakeProvider((id: string) => ({ modelId: id })),
    memoryTitle: actual.memoryTitle,
    countCharacters: actual.countCharacters,
    memoryContent: actual.memoryContent,
    creditLotService: { chargeOnce },
  };
});

vi.mock("@server/modules", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, memoryService: { commitConsolidation, consolidationInput } };
});

const { consolidateWindow } = await import("@server/agent/memory-consolidator.js");

const USAGE = { inputTokens: 10, inputTokenDetails: { noCacheTokens: 10 }, outputTokens: 10, outputTokenDetails: {}, totalTokens: 20 };

/** What one model call does. */
type Attempt = "valid" | "invalid" | "cut" | "throws";

/** How the write ends when it is reached. */
type Commit = "written" | "superseded" | "throws";

const attemptArbitrary: fc.Arbitrary<Attempt> = fc.constantFrom("valid", "invalid", "invalid", "cut", "throws");
const commitArbitrary: fc.Arbitrary<Commit> = fc.constantFrom("written", "superseded", "throws");

/**
 * The model's side of one attempt.
 * @param attempt - What it does.
 * @returns What the call resolves to, or throws.
 * @throws {Error} When the attempt is a failed call.
 */
function respond(attempt: Attempt): unknown {
  if (attempt === "throws") throw new Error("502 upstream");
  const text =
    attempt === "valid"
      ? JSON.stringify({ progress: "p", operations: [] })
      : attempt === "cut"
        ? '{"progress": "p", "operations": ['
        : "not json";
  return { text, finishReason: attempt === "cut" ? "length" : "stop", usage: USAGE, response: { id: "g" } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("one consolidation under any run of answers", () => {
  it("writes at most once, only a checked answer, and charges every call that came back under its own key", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(attemptArbitrary, { minLength: ATTEMPTS, maxLength: ATTEMPTS }), commitArbitrary, async (attempts, commit) => {
        vi.clearAllMocks();
        const queue = [...attempts];
        generateTextRetry.mockImplementation(async () => respond(queue.shift() ?? "invalid"));
        commitConsolidation.mockImplementation(async () => {
          if (commit === "throws") throw new Error("deadlock detected");
          return commit;
        });

        const outcome = await consolidateWindow({
          userId: "11111111-1111-4111-8111-111111111111",
          conversationId: "22222222-2222-4222-8222-222222222222",
          projectId: "33333333-3333-4333-8333-333333333333",
          turns: [{ turnIndex: 1, messages: [{ role: "user", content: "hi" }] }],
          watermarkBefore: 0,
          newWatermark: 1,
        });

        // The run the model actually went through: up to the first answer
        // that passed, or the first that ended the fold outright.
        const ran = attempts.slice(0, generateTextRetry.mock.calls.length);
        const firstEnd = attempts.findIndex((a) => a !== "invalid");
        const ended = firstEnd === -1 ? ATTEMPTS : firstEnd + 1;
        expect(generateTextRetry.mock.calls.length).toBe(ended);

        const passed = ran.at(-1) === "valid";
        expect(commitConsolidation).toHaveBeenCalledTimes(passed ? 1 : 0);
        if (!passed) expect(outcome).toBe("failed");
        if (passed) expect(outcome).toBe(commit === "throws" ? "failed" : commit);

        const keys = chargeOnce.mock.calls.map((call) => call[1]);
        expect(keys).toHaveLength(ran.filter((a) => a !== "throws").length);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 200 },
    );
  });

  it("charges every call of every fold under its own key, however many folds start from the same watermark", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ watermarkBefore: fc.integer({ min: 0, max: 2 }), attempts: fc.array(attemptArbitrary, { minLength: ATTEMPTS, maxLength: ATTEMPTS }) }), {
          minLength: 1,
          maxLength: 5,
        }),
        async (folds) => {
          vi.clearAllMocks();
          commitConsolidation.mockResolvedValue("written");
          let came = 0;
          for (const fold of folds) {
            const queue = [...fold.attempts];
            generateTextRetry.mockImplementation(async () => respond(queue.shift() ?? "invalid"));
            const before = generateTextRetry.mock.calls.length;
            await consolidateWindow({
              userId: "11111111-1111-4111-8111-111111111111",
              conversationId: "22222222-2222-4222-8222-222222222222",
              projectId: "33333333-3333-4333-8333-333333333333",
              turns: [{ turnIndex: 1, messages: [{ role: "user", content: "hi" }] }],
              watermarkBefore: fold.watermarkBefore,
              newWatermark: fold.watermarkBefore + 1,
            });
            came += fold.attempts.slice(0, generateTextRetry.mock.calls.length - before).filter((a) => a !== "throws").length;
          }

          const keys = chargeOnce.mock.calls.map((call) => call[1]);
          expect(keys).toHaveLength(came);
          expect(new Set(keys).size).toBe(keys.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});
