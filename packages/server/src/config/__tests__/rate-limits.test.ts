// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Entries the rate-limits loader reads from the shipped
 * `config/rate-limits.yaml`.
 *
 * The package setup stubs this loader for every file with permissive numbers,
 * so the real module is taken with `importActual` to read the real file.
 */

import { describe, it, expect, vi } from "vitest";
import type * as RateLimitsModule from "@server/config/rate-limits.js";

const { getRateLimit } = await vi.importActual<typeof RateLimitsModule>(
  "@server/config/rate-limits.js",
);

describe("rate limits — config/rate-limits.yaml", () => {
  // The back office's calls into the internal API (inner#1410 §4.4), keyed by
  // the connecting socket. 120 a minute covers an operator working through a
  // queue while capping a runaway caller in front of Stripe.
  it("gives internal-api 120 requests per 60 seconds", () => {
    expect(getRateLimit("internal-api")).toEqual({ max: 120, windowSeconds: 60 });
  });
});
