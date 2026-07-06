// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from "vitest";

import { defaultJobOpts } from "@core/infra/queue.js";

/**
 * defaultJobOpts must select the custom "jitter" backoff so BullMQ routes
 * retries through the Worker's `settings.backoffStrategy` (jitterBackoffStrategy)
 * instead of a builtin deterministic backoff (#1625 Slice 2). This is the
 * credit-billing retry chain, so the wiring is pinned.
 */
describe("defaultJobOpts", () => {
  it("uses the custom 'jitter' backoff (no builtin exponential, no fixed delay)", () => {
    expect(defaultJobOpts().backoff).toEqual({ type: "jitter" });
  });

  it("keeps a bounded attempts count and retention windows", () => {
    const opts = defaultJobOpts();
    expect(opts.attempts).toBeGreaterThanOrEqual(1);
    expect(opts.removeOnComplete.age).toBeGreaterThan(0);
    expect(opts.removeOnFail.age).toBeGreaterThan(0);
  });
});
