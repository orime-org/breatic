// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The refund-disposition time limits (inner#1410 §7.4).
 *
 * Every key is required: a default standing in for a key someone renamed or
 * dropped would keep the loop running on a number nobody chose. The one rule
 * that ties two keys together keeps a claim's lease alive for as long as its
 * holder can still be waiting on Stripe, on the read before the create, the
 * create and the read after it — if the lease ran out first, a second instance could claim the same
 * disposition and refund the buyer twice.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { MONOREPO_ROOT } from "@breatic/core";
import { creditRefundSchema, getCreditRefundConfig } from "@server/config/credit-refund.js";

/** The values §7.4 ships, in the file's own spelling. */
const SHIPPED = {
  stripe_call_timeout_ms: 20000,
  lease_seconds: 120,
  loop_interval_seconds: 60,
  backoff_base_seconds: 60,
  backoff_max_seconds: 3600,
  max_attempts: 8,
  stale_sending_minutes: 10,
  reconcile_window_days: 30,
} as const;

const KEYS = Object.keys(SHIPPED) as Array<keyof typeof SHIPPED>;

/**
 * A valid file with some keys changed or removed.
 * @param over - Keys to replace; a key mapped to `undefined` is removed
 * @returns The raw file contents as the yaml parser would hand them over
 */
function file(over: Partial<Record<keyof typeof SHIPPED, unknown>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...SHIPPED, ...over };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

describe("credit refund config — the shipped file", () => {
  it("config/credit-refund.yaml holds exactly the §7.4 values", () => {
    const raw = parse(
      readFileSync(resolve(MONOREPO_ROOT, "config/credit-refund.yaml"), "utf-8"),
    ) as unknown;
    expect(raw).toEqual(SHIPPED);
  });

  it("getCreditRefundConfig returns each key's shipped value", () => {
    expect(getCreditRefundConfig()).toEqual({
      stripeCallTimeoutMs: 20000,
      leaseSeconds: 120,
      loopIntervalSeconds: 60,
      backoffBaseSeconds: 60,
      backoffMaxSeconds: 3600,
      maxAttempts: 8,
      staleSendingMinutes: 10,
      reconcileWindowDays: 30,
    });
  });
});

describe("credit refund config — schema", () => {
  it("accepts the shipped values", () => {
    expect(creditRefundSchema.parse(file())).toEqual(SHIPPED);
  });

  it.each(KEYS)("refuses a file without %s, naming it", (key) => {
    expect(() => creditRefundSchema.parse(file({ [key]: undefined }))).toThrow(
      new RegExp(key),
    );
  });

  it.each(KEYS)("refuses a zero, negative or fractional %s, naming it", (key) => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => creditRefundSchema.parse(file({ [key]: bad }))).toThrow(new RegExp(key));
    }
  });

  // The holder of a lease makes up to three Stripe calls in one attempt — a
  // resume reads `refunds.list` first, then creates, then reads again — each
  // bounded by `stripe_call_timeout_ms`, and then still has to write its
  // answer back; ten seconds is the room left for that (§7.4:
  // 3 × stripe_call_timeout_ms + 10000 < lease_seconds × 1000). Equality is
  // already too tight.
  it.each([
    [20000, 30],
    [20000, 45],
    [20000, 50],
    [20000, 51],
    [20000, 70],
    [36667, 120],
    [54999, 120],
    [55000, 120],
    [110000, 120],
  ])(
    "refuses a %d ms Stripe timeout under a %d s lease, naming both keys",
    (timeoutMs, leaseSeconds) => {
      const run = (): unknown =>
        creditRefundSchema.parse(
          file({ stripe_call_timeout_ms: timeoutMs, lease_seconds: leaseSeconds }),
        );
      expect(run).toThrow(/stripe_call_timeout_ms/);
      expect(run).toThrow(/lease_seconds/);
    },
  );

  it.each([
    [20000, 71],
    [36666, 120],
  ])("accepts a %d ms Stripe timeout under a %d s lease", (timeoutMs, leaseSeconds) => {
    expect(() =>
      creditRefundSchema.parse(
        file({ stripe_call_timeout_ms: timeoutMs, lease_seconds: leaseSeconds }),
      ),
    ).not.toThrow();
  });
});
