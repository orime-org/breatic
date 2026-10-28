// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { NoUpstreamAvailable, UpstreamRequestRejected } from "../../errors.js";
import { planRoute, type Candidate } from "../route.js";

const official: Candidate = { upstream: "kling", weight: 0, configured: true, envVar: "KLING_ACCESS_KEY", estimateUsd: 0.5 };
const wavespeed: Candidate = { upstream: "wavespeed", weight: 1, configured: true, envVar: "WAVESPEED_API_KEY", estimateUsd: 0.4 };
const fal: Candidate = { upstream: "fal", weight: 2, configured: true, envVar: "FAL_KEY", estimateUsd: 0.45 };

describe("planRoute — default", () => {
  it("orders configured upstreams by weight, lowest first", () => {
    const plan = planRoute("m", { mode: "default" }, [fal, official, wavespeed]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["kling", "wavespeed", "fal"]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips an upstream without a key and names its env var", () => {
    const plan = planRoute("m", { mode: "default" }, [{ ...official, configured: false }, wavespeed, fal]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["wavespeed", "fal"]);
    expect(plan.skipped).toEqual([{ upstream: "kling", kind: "missing_key", envVar: "KLING_ACCESS_KEY" }]);
  });

  it("throws NoUpstreamAvailable naming every missing env var when nothing is configured", () => {
    const all = [official, wavespeed, fal].map((c) => ({ ...c, configured: false }));
    const error = captured(() => planRoute("seedance", { mode: "default" }, all));
    expect(error).toBeInstanceOf(NoUpstreamAvailable);
    expect((error as NoUpstreamAvailable).model).toBe("seedance");
    expect((error as NoUpstreamAvailable).reasons).toEqual([
      { upstream: "kling", kind: "missing_key", envVar: "KLING_ACCESS_KEY" },
      { upstream: "wavespeed", kind: "missing_key", envVar: "WAVESPEED_API_KEY" },
      { upstream: "fal", kind: "missing_key", envVar: "FAL_KEY" },
    ]);
  });

  it("property: the first upstream tried is the configured one with the smallest weight", () => {
    fc.assert(fc.property(candidatesArb(), (candidates) => {
      const configured = candidates.filter((c) => c.configured);
      fc.pre(configured.length > 0);
      const plan = planRoute("m", { mode: "default" }, candidates);
      const lowest = Math.min(...configured.map((c) => c.weight));
      expect(plan.order[0]?.weight).toBe(lowest);
      expect(plan.order.map((c) => c.weight)).toEqual([...plan.order.map((c) => c.weight)].sort((a, b) => a - b));
      expect(plan.order).toHaveLength(configured.length);
      expect(plan.skipped).toHaveLength(candidates.length - configured.length);
    }));
  });
});

describe("planRoute — explicit upstream", () => {
  it("plans only the named upstream", () => {
    const plan = planRoute("m", { mode: "upstream", upstream: "fal" }, [official, wavespeed, fal]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["fal"]);
  });

  it("rejects an upstream the model has no binding for, without trying another", () => {
    const error = captured(() => planRoute("m", { mode: "upstream", upstream: "replicate" }, [official, wavespeed]));
    expect(error).toBeInstanceOf(UpstreamRequestRejected);
    expect((error as UpstreamRequestRejected).upstream).toBe("replicate");
  });

  it("throws NoUpstreamAvailable naming the env var when the named upstream has no key", () => {
    const error = captured(() => planRoute("m", { mode: "upstream", upstream: "fal" }, [official, { ...fal, configured: false }]));
    expect(error).toBeInstanceOf(NoUpstreamAvailable);
    expect((error as NoUpstreamAvailable).reasons).toEqual([{ upstream: "fal", kind: "missing_key", envVar: "FAL_KEY" }]);
  });

  it("property: the plan never holds any upstream but the named one", () => {
    fc.assert(fc.property(candidatesArb(), fc.nat(), (candidates, pick) => {
      const named = candidates[pick % candidates.length]!;
      fc.pre(named.configured);
      const plan = planRoute("m", { mode: "upstream", upstream: named.upstream }, candidates);
      expect(plan.order.map((c) => c.upstream)).toEqual([named.upstream]);
    }));
  });
});

describe("planRoute — cheapest", () => {
  it("puts an upstream with no estimate after every priced one, whatever its weight", () => {
    const plan = planRoute("m", { mode: "cheapest" }, [{ ...official, estimateUsd: undefined }, fal]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["fal", "kling"]);
  });

  it("orders by this call's estimate, lowest first", () => {
    const plan = planRoute("m", { mode: "cheapest" }, [official, wavespeed, fal]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["wavespeed", "fal", "kling"]);
  });

  it("breaks an estimate tie by weight", () => {
    const plan = planRoute("m", { mode: "cheapest" }, [{ ...fal, estimateUsd: 0.4 }, wavespeed]);
    expect(plan.order.map((c) => c.upstream)).toEqual(["wavespeed", "fal"]);
  });

  it("property: the first upstream tried has the lowest estimate among configured ones", () => {
    fc.assert(fc.property(candidatesArb(), (candidates) => {
      const configured = candidates.filter((c) => c.configured);
      fc.pre(configured.length > 0);
      const plan = planRoute("m", { mode: "cheapest" }, candidates);
      const cheapest = Math.min(...configured.map((c) => c.estimateUsd!));
      expect(plan.order[0]?.estimateUsd).toBe(cheapest);
      for (let i = 1; i < plan.order.length; i++) {
        const [a, b] = [plan.order[i - 1]!, plan.order[i]!];
        expect(a.estimateUsd! < b.estimateUsd! || (a.estimateUsd === b.estimateUsd && a.weight < b.weight)).toBe(true);
      }
    }));
  });
});

/**
 * One to six upstreams with unique weights and names, any key state and any estimate.
 * @returns The arbitrary.
 */
function candidatesArb(): fc.Arbitrary<Candidate[]> {
  return fc.uniqueArray(fc.nat(20), { minLength: 1, maxLength: 6 }).chain((weights) =>
    fc.tuple(...weights.map((weight, i) => fc.record({
      upstream: fc.constant(`u${i}`),
      weight: fc.constant(weight),
      configured: fc.boolean(),
      envVar: fc.constant(`KEY_${i}`),
      estimateUsd: fc.integer({ min: 0, max: 50 }).map((cents) => cents / 100),
    }))));
}

/**
 * Run a throwing call and hand back what it threw.
 * @param call - The call.
 * @returns The thrown value.
 * @throws {Error} When the call does not throw.
 */
function captured(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
