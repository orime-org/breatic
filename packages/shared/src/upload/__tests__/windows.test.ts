// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long one part may take, and why every window around it has to be wider.
 *
 * Both answers come from one piece of arithmetic: the browser sizes each
 * part's deadline with it, and the ticket endpoint checks the Durable Object's
 * idle window against it. Two copies would drift apart the first time either
 * side's figures moved.
 */

import { describe, it, expect } from "vitest";
import {
  partDeadlineMs,
  partRetryBudgetMs,
  assertUploadWindows,
} from "@shared/upload/windows.js";
import { MAX_RETRIES, BASE_DELAY_MS } from "@shared/http/constants.js";

const CFG = { requestTimeoutMs: 30_000, minBytesPerSec: 65_536 };

describe("partDeadlineMs", () => {
  it("gives a small part the floor rather than a window it cannot use", () => {
    expect(partDeadlineMs(1024, CFG)).toBe(30_000);
  });

  it("scales with the bytes once they need longer than the floor", () => {
    // 8 MiB at 64 KiB/s is 128 seconds, well past the floor.
    expect(partDeadlineMs(8 * 1024 * 1024, CFG)).toBe(128_000);
  });
});

describe("partRetryBudgetMs", () => {
  it("counts every delivery the transport makes, not just the first", () => {
    const oneDelivery = partDeadlineMs(8 * 1024 * 1024, CFG);

    const budget = partRetryBudgetMs(8 * 1024 * 1024, CFG);

    expect(budget).toBeGreaterThan((MAX_RETRIES + 1) * oneDelivery);
  });

  it("adds the exponential ceiling of the waits between them", () => {
    const deliveries = (MAX_RETRIES + 1) * partDeadlineMs(1024, CFG);
    const backoff = BASE_DELAY_MS + BASE_DELAY_MS * 2;

    expect(partRetryBudgetMs(1024, CFG)).toBe(deliveries + backoff);
  });

  // The shipped figures. An 8 MiB part can hold the browser for longer than
  // five minutes, which is what the Durable Object's idle window has to clear.
  it("exceeds five minutes for one part at the shipped part size", () => {
    expect(partRetryBudgetMs(8 * 1024 * 1024, CFG)).toBeGreaterThan(300_000);
  });
});

describe("assertUploadWindows", () => {
  /** The shipped figures, with the pieces a case varies. */
  const windows = (over: Record<string, number> = {}): Parameters<
    typeof assertUploadWindows
  >[0] => ({
    partSizeBytes: 8 * 1024 * 1024,
    alarmIdleSeconds: 600,
    sessionTokenTtlSeconds: 900,
    requestTimeoutMs: 30_000,
    minBytesPerSec: 65_536,
    ...over,
  });

  it("accepts figures that leave every window wider than what it holds", () => {
    expect(() => assertUploadWindows(windows())).not.toThrow();
  });

  // One part's retries run to about 387 seconds, while an alarm at 300 judges
  // the upload dead: every part already written is dropped, and the browser is
  // still delivering.
  it("refuses an idle window a single part's retries can outlast", () => {
    expect(() => assertUploadWindows(windows({ alarmIdleSeconds: 300 }))).toThrow(
      /alarm_idle_seconds/,
    );
  });

  // The token is re-issued with every part, so it only has to cover the gap
  // between two of them — and the longest gap the alarm allows is its own
  // window.
  it("refuses a session token that expires inside the idle window", () => {
    expect(() =>
      assertUploadWindows(windows({ sessionTokenTtlSeconds: 600 })),
    ).toThrow(/session_token_ttl_seconds/);
  });
});
