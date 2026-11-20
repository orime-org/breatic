// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** What a media run is held for, whichever keys it carries (inner#1953). */

import { describe, expect, it, vi } from "vitest";

const precheck = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@server/modules/credit/credit-precheck.service.js", () => ({ precheckCredits: precheck }));

import { creditsToHold, type RunKeys } from "@server/modules/task/run-keys.js";

const OURS = { keys: undefined, keyId: null, payerUserId: null } as unknown as RunKeys["media"];
const ACCOUNT = { keys: undefined, keyId: "row-1", payerUserId: "u-1" } as unknown as RunKeys["media"];

describe("creditsToHold", () => {
  it("holds the estimate when the run carries no keys at all", async () => {
    expect(await creditsToHold(null, "p", "u", async () => 7)).toBe(7);
    expect(await creditsToHold(undefined, "p", "u", async () => 7)).toBe(7);
  });

  it("holds the estimate on our keys", async () => {
    expect(await creditsToHold({ media: OURS, llm: null, llmCharged: false }, "p", "u", async () => 3)).toBe(3);
  });

  it("holds nothing on the payer's key, and checks the balance only for a charged step on ours", async () => {
    expect(await creditsToHold({ media: ACCOUNT, llm: null, llmCharged: false }, "p", "u", async () => 3)).toBeNull();
    expect(precheck).not.toHaveBeenCalled();
    expect(await creditsToHold({ media: ACCOUNT, llm: OURS, llmCharged: true }, "p", "u", async () => 3)).toBeNull();
    expect(precheck).toHaveBeenCalledOnce();
  });
});
