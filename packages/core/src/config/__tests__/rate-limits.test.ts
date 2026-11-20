// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Entries the rate-limits loader reads from the shipped
 * `config/rate-limits.yaml`.
 *
 * The package setup stubs this loader for every file with permissive numbers,
 * so the real module is taken with `importActual` to read the real file.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { getRateLimit } from "@core/config/rate-limits.js";

describe("rate limits — config/rate-limits.yaml", () => {
  it("allows fifty invitation attempts per user per day", () => {
    expect(getRateLimit("invite")).toEqual({ max: 50, windowSeconds: 86400 });
  });

  it("allows thirty public invitation previews per address per five minutes", () => {
    expect(getRateLimit("invite-preview")).toEqual({ max: 30, windowSeconds: 300 });
  });

  // The back office's calls into the internal API (inner#1410 §4.4), keyed by
  // the connecting socket. 120 a minute covers an operator working through a
  // queue while capping a runaway caller in front of Stripe.
  it("gives internal-api 120 requests per 60 seconds", () => {
    expect(getRateLimit("internal-api")).toEqual({ max: 120, windowSeconds: 60 });
  });

  // The text mini-tool (inner#1860): the per-user lock is gone, so this limit
  // and the per-run charge are what bound one person's spend.
  it("has a text-tool entry with a positive count and window", () => {
    const { max, windowSeconds } = getRateLimit("text-tool");
    expect(Number.isInteger(max) && max > 0).toBe(true);
    expect(Number.isInteger(windowSeconds) && windowSeconds > 0).toBe(true);
  });

  it("reads the file in the configuration directory the caller names", () => {
    const dir = mkdtempSync(join(tmpdir(), "rate-limits-"));
    writeFileSync(join(dir, "rate-limits.yaml"), "own-action:\n  max: 2\n  window_seconds: 5\n");
    expect(getRateLimit("own-action", dir)).toEqual({ max: 2, windowSeconds: 5 });
    expect(() => getRateLimit("invite", dir)).toThrow(/"invite" is not configured/);
  });
});
