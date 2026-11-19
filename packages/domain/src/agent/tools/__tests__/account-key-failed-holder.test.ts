// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1953: a tool call that failed on the payer's own key tells the model whose key it was to the user it answers,
 * so the Agent can say "your key" or "the Studio Admin's key" while the turn itself goes on.
 */

import { describe, expect, it } from "vitest";
import { AccountKeyFailure } from "@breatic/provider";

import { accountKeyFailed } from "../failure.js";

const noBalance = new AccountKeyFailure("google/gemini-3.8-flash", "account_key_failed", { upstream: "openrouter", reason: "no_balance" });

describe("a tool call that failed on the payer's own key", () => {
  it("tells the model it is the user's own key when the user is the payer", () => {
    const said = accountKeyFailed(noBalance, "self")?.message ?? "";
    expect(said).toContain("the key the user saved in BYOK settings");
    expect(said).not.toContain("Studio's payer");
  });

  it("tells the model it is the Studio Admin's key when the user is a member", () => {
    const said = accountKeyFailed(noBalance, "admin")?.message ?? "";
    expect(said).toContain("the key the Studio Admin saved in BYOK settings");
    expect(said).toContain("ask the Studio Admin");
  });

  it("names the payer when whose key it is was not given", () => {
    expect(accountKeyFailed(noBalance)?.message).toContain("the key the Studio's payer saved in BYOK settings");
  });
});
