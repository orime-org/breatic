// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How much of the caller's window is left for the container (#207).
 *
 * The object is stored and hashed before the container is asked anything, so
 * by the time this is read the upload has already succeeded. What is decided
 * here is only whether a resolution and a poster can still be fetched inside
 * the time the caller is waiting — and a caller whose own deadline fires
 * throws the finished upload away.
 */

import { describe, it, expect } from "vitest";

import { runWindowLeft } from "@ingest/run-window.js";

const LIMITS = { runDeadlineMs: 150_000, toolTimeoutMs: 60_000 };

describe("runWindowLeft", () => {
  it("gives the container its whole allowance when the window is wide", () => {
    expect(runWindowLeft(LIMITS, 1_000_000, 700_000)).toEqual(LIMITS);
  });

  it("gives it what is left when the window is narrower than the allowance", () => {
    // 40 s of a 290 s call left after a transfer that took 250 s.
    expect(runWindowLeft(LIMITS, 1_000_000, 960_000)).toEqual({
      runDeadlineMs: 40_000,
      toolTimeoutMs: 60_000,
    });
  });

  it("asks for no run at all once the window is spent", () => {
    // The alternative is starting a run the caller will not wait for, which
    // ends with a stored, hashed object thrown away and the source blamed.
    expect(runWindowLeft(LIMITS, 1_000_000, 1_000_000)).toBeNull();
    expect(runWindowLeft(LIMITS, 1_000_000, 1_200_000)).toBeNull();
  });

  it("leaves a caller that named no window alone", () => {
    // The lanes that send their own bytes name none, and their call carries no
    // transfer inside it.
    expect(runWindowLeft(LIMITS, null, 1_200_000)).toEqual(LIMITS);
  });

  it("carries a caller that asked for no run at all through unchanged", () => {
    expect(runWindowLeft(null, 1_000_000, 700_000)).toBeNull();
  });
});
