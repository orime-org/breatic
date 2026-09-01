// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one model call's tokens come to in credits.
 *
 * Three places charge by token and share this one arithmetic: a chat turn, a
 * memory consolidation, a text mini-tool. Written out at each of them, a
 * change to the rounding or the multiplier in one place would charge two
 * people differently for the same work.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@breatic/core", () => ({ env: { CREDIT_MULTIPLIER: 2 } }));

const { creditsForTokens } = await import("@server/modules/credit/token-pricing.js");

describe("pricing by token", () => {
  it("charges one credit per thousand tokens, times the deployment's multiplier", () => {
    expect(creditsForTokens(1000)).toBe(2);
    expect(creditsForTokens(3000)).toBe(6);
  });

  it("rounds up, so a call that ran is never free", () => {
    // A tenth of a thousand tokens still spent something. Rounding down would
    // make every call under the multiplier's own step cost nothing at all.
    expect(creditsForTokens(1)).toBe(1);
    expect(creditsForTokens(499)).toBe(1);
    expect(creditsForTokens(501)).toBe(2);
  });

  it("charges nothing for a call that spent nothing", () => {
    expect(creditsForTokens(0)).toBe(0);
  });
});
