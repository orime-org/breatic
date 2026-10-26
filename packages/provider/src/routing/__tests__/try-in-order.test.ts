// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { NoUpstreamAvailable } from "../../errors.js";
import type { Failure, Phase } from "../decide.js";
import type { Candidate, RoutePlan } from "../route.js";
import { tryInOrder } from "../try-in-order.js";

/** A thrown failure the test's classifier recognises. */
class Fail extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind);
  }
}

/**
 * The failure class of an error thrown by a scripted attempt.
 * @param error - What the attempt threw.
 * @returns Its class, or null for anything else.
 */
const classify = (error: unknown): Failure | null => (error instanceof Fail ? error.failure : null);

/**
 * A plan over the named upstreams, in that order.
 * @param names - Upstream names.
 * @param skipped - Upstreams skipped for a missing key.
 * @returns The plan.
 */
function plan(names: string[], skipped: string[] = []): RoutePlan {
  return {
    model: "m",
    order: names.map<Candidate>((upstream, weight) => ({ upstream, weight, configured: true, envVar: `${upstream}_KEY` })),
    skipped: skipped.map((upstream) => ({ upstream, kind: "missing_key", envVar: `${upstream}_KEY` })),
  };
}

/**
 * An attempt that answers from a per-upstream script, recording every call.
 * @param script - For each upstream, what each successive call does: a value, or a failure.
 * @returns The attempt and the log of upstreams called.
 */
function scripted(script: Record<string, (string | Failure)[]>): { attempt: (c: Candidate) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  const cursor: Record<string, number> = {};
  return {
    calls,
    attempt: async (candidate) => {
      calls.push(candidate.upstream);
      const steps = script[candidate.upstream] ?? [];
      const i = cursor[candidate.upstream] ?? 0;
      cursor[candidate.upstream] = i + 1;
      const step = steps[Math.min(i, steps.length - 1)];
      if (step === undefined) throw new Error(`no script for ${candidate.upstream}`);
      if (typeof step === "string") return step;
      throw new Fail(step);
    },
  };
}

const media = (attempt: (c: Candidate) => Promise<string>) => ({ phase: "media_submit" as Phase, maxRetries: 2, attempt, classify });
const llm = (attempt: (c: Candidate) => Promise<string>) => ({ phase: "llm_before_content" as Phase, maxRetries: 2, attempt, classify });

describe("tryInOrder", () => {
  it("returns the first success and who served it", async () => {
    const { attempt, calls } = scripted({ a: ["ok-a"] });
    await expect(tryInOrder(plan(["a", "b"]), media(attempt))).resolves.toEqual({ value: "ok-a", servedBy: "a" });
    expect(calls).toEqual(["a"]);
  });

  it("switches on a switchable failure and is served by the next upstream", async () => {
    const { attempt, calls } = scripted({ a: [{ kind: "http_status", status: 503 }], b: ["ok-b"] });
    await expect(tryInOrder(plan(["a", "b"]), media(attempt))).resolves.toEqual({ value: "ok-b", servedBy: "b" });
    expect(calls).toEqual(["a", "b"]);
  });

  it("stops on a 400 and rethrows the attempt's own error without trying another upstream", async () => {
    const { attempt, calls } = scripted({ a: [{ kind: "http_status", status: 400 }], b: ["ok-b"] });
    const error = await tryInOrder(plan(["a", "b"]), media(attempt)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Fail);
    expect((error as Fail).failure).toEqual({ kind: "http_status", status: 400 });
    expect(calls).toEqual(["a"]);
  });

  it("stops on no_answer: the first upstream may have accepted, so nothing else is sent", async () => {
    const { attempt, calls } = scripted({ a: [{ kind: "no_answer" }], b: ["ok-b"] });
    await expect(tryInOrder(plan(["a", "b"]), media(attempt))).rejects.toBeInstanceOf(Fail);
    expect(calls).toEqual(["a"]);
  });

  it("rethrows an error it cannot classify, untouched", async () => {
    const boom = new TypeError("bug");
    const attempt = async (): Promise<string> => { throw boom; };
    await expect(tryInOrder(plan(["a", "b"]), media(attempt))).rejects.toBe(boom);
  });

  it("LLM: retries the same upstream up to maxRetries, then switches", async () => {
    const { attempt, calls } = scripted({ a: [{ kind: "http_status", status: 429 }], b: ["ok-b"] });
    await expect(tryInOrder(plan(["a", "b"]), llm(attempt))).resolves.toEqual({ value: "ok-b", servedBy: "b" });
    expect(calls).toEqual(["a", "a", "a", "b"]);
  });

  it("LLM: a retry on the same upstream can succeed", async () => {
    const { attempt, calls } = scripted({ a: [{ kind: "http_status", status: 500 }, "ok-a"] });
    await expect(tryInOrder(plan(["a", "b"]), llm(attempt))).resolves.toEqual({ value: "ok-a", servedBy: "a" });
    expect(calls).toEqual(["a", "a"]);
  });

  it("throws NoUpstreamAvailable with the skipped ones first and each failure after, when all switch away", async () => {
    const { attempt } = scripted({ a: [{ kind: "not_sent" }], b: [{ kind: "model_not_found" }] });
    const error = await tryInOrder(plan(["a", "b"], ["k"]), media(attempt)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoUpstreamAvailable);
    expect((error as NoUpstreamAvailable).reasons).toEqual([
      { upstream: "k", kind: "missing_key", envVar: "k_KEY" },
      { upstream: "a", kind: "failed", failure: "not_sent" },
      { upstream: "b", kind: "failed", failure: "model_not_found" },
    ]);
  });

  it("property: after a stop-class failure no other upstream is ever called", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(stepArb(), { minLength: 1, maxLength: 5 }),
      fc.constantFrom<Phase>("media_submit", "llm_before_content"),
      async (steps, phase) => {
        const names = steps.map((_, i) => `u${i}`);
        const script = Object.fromEntries(names.map((n, i) => [n, [named(steps[i]!, n)]]));
        const { attempt, calls } = scripted(script);
        await tryInOrder(plan(names), { phase, maxRetries: 1, attempt, classify }).catch(() => undefined);
        expect(calls[0]).toBe("u0");
        const firstStop = steps.findIndex((s) => typeof s !== "string" && isStop(s));
        if (firstStop >= 0) {
          expect(calls.every((c) => names.indexOf(c) <= firstStop)).toBe(true);
          expect(calls.at(-1)).toBe(names[firstStop]);
        }
      }));
  });

  it("property: a success is reported as served by the upstream that answered it", async () => {
    await fc.assert(fc.asyncProperty(fc.array(stepArb(), { minLength: 1, maxLength: 5 }), async (steps) => {
      const names = steps.map((_, i) => `u${i}`);
      const { attempt, calls } = scripted(Object.fromEntries(names.map((n, i) => [n, [named(steps[i]!, n)]])));
      const result = await tryInOrder(plan(names), media(attempt)).catch(() => null);
      expect(calls[0]).toBe("u0");
      if (steps[0] === "ok") expect(result).toEqual({ value: "ok-u0", servedBy: "u0" });
      if (result !== null) {
        expect(result.value).toBe(`ok-${result.servedBy}`);
        expect(calls.at(-1)).toBe(result.servedBy);
      }
    }));
  });
});

/**
 * Give a scripted success the name of the upstream that returns it.
 * @param step - A scripted outcome.
 * @param upstream - The upstream it belongs to.
 * @returns The outcome, a success renamed `ok-<upstream>`.
 */
function named(step: string | Failure, upstream: string): string | Failure {
  return typeof step === "string" ? `ok-${upstream}` : step;
}

/**
 * Whether a failure is one that must not move to another upstream.
 * @param failure - The failure.
 * @returns True for 4xx other than 429, no_answer and aborted.
 */
function isStop(failure: Failure): boolean {
  if (failure.kind === "no_answer" || failure.kind === "aborted") return true;
  return failure.kind === "http_status" && failure.status !== 429 && failure.status < 500;
}

/**
 * One scripted outcome: success (named after the upstream later) or a failure.
 * @returns The arbitrary.
 */
function stepArb(): fc.Arbitrary<string | Failure> {
  return fc.oneof(
    fc.constant("ok"),
    fc.constant<Failure>({ kind: "not_sent" }),
    fc.constant<Failure>({ kind: "no_answer" }),
    fc.constant<Failure>({ kind: "model_not_found" }),
    fc.constant<Failure>({ kind: "aborted" }),
    fc.constantFrom(400, 422, 429, 500, 503).map<Failure>((status) => ({ kind: "http_status", status })),
  );
}
