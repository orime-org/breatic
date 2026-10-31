// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The idempotency contract both ends read: which requests run once, how long
 * the server remembers a finished one, and when the browser stops asking.
 */

import { describe, it, expect } from "vitest";
import {
  IDEMPOTENCY_SCOPES,
  IDEMPOTENCY_RETENTION_SECONDS,
  IDEMPOTENCY_CLIENT_MARGIN_SECONDS,
  idempotencyRetryDeadline,
} from "@shared/idempotency.js";

describe("idempotency scopes", () => {
  // Membership checkout and plan change share one scope: one press of the
  // membership panel is one intent whichever of the two it sends.
  it("name the requests that run once per press", () => {
    expect([...IDEMPOTENCY_SCOPES].sort()).toEqual(
      [
        "conversation",
        "credits-checkout",
        "generate",
        "membership",
        "mini-tool",
        "project",
        "transcribe",
        "understand",
      ].sort(),
    );
  });

  it("each have a retention", () => {
    for (const scope of IDEMPOTENCY_SCOPES) {
      expect(IDEMPOTENCY_RETENTION_SECONDS[scope]).toBeGreaterThan(
        IDEMPOTENCY_CLIENT_MARGIN_SECONDS,
      );
    }
  });

  it("keep a credits checkout as long as its Stripe session lives", () => {
    expect(IDEMPOTENCY_RETENTION_SECONDS["credits-checkout"]).toBe(2 * 60 * 60);
  });

  // A membership checkout keeps Stripe's default lifetime, 24 hours from its
  // creation, which is also the most Stripe accepts; a press that replays it
  // must stop within that.
  it("keep a membership press no longer than a Stripe Checkout Session can stay open", () => {
    expect(IDEMPOTENCY_RETENTION_SECONDS.membership).toBeLessThanOrEqual(24 * 60 * 60);
  });
});

describe("the instant the browser stops re-sending", () => {
  it("is the retention minus the margin after the press", () => {
    const pressedAt = 1_000_000;
    expect(idempotencyRetryDeadline("credits-checkout", pressedAt)).toBe(
      pressedAt + (7200 - IDEMPOTENCY_CLIENT_MARGIN_SECONDS) * 1000,
    );
  });

  it("leaves more room than one HTTP request can take", () => {
    // Node's requestTimeout gives a request 300 seconds to arrive; the last
    // re-send must land before the record expires.
    expect(IDEMPOTENCY_CLIENT_MARGIN_SECONDS).toBeGreaterThan(300);
  });
});
