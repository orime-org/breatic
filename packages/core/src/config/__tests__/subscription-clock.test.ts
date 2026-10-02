// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The subscription clock touches `config/subscription.yaml` only when a
 * reading needs the renewal window (#307).
 *
 * An install with payments off has no copy of that file, yet every sign-in
 * reads the account's tier through this clock. Reading the file when the clock
 * is built would fail those sign-ins for an account that has no subscription
 * rows to judge.
 */

import { describe, it, expect, vi } from "vitest";

const readFileSync = vi.hoisted(() =>
  vi.fn(() => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
    });
  }),
);
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  readFileSync,
}));

import { subscriptionClock } from "@core/config/subscription.js";
import { subscriptionSituation } from "@core/auth/subscription-state.js";

describe("subscriptionClock without config/subscription.yaml (#307)", () => {
  it("reads an account with no subscription rows without opening the file", () => {
    const reading = subscriptionSituation([], subscriptionClock());

    expect(reading.situation).toBe("none");
    expect(reading.lapsed).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("opens the file once the renewal window is asked for", () => {
    const clock = subscriptionClock();

    expect(() => clock.staleAfterMs).toThrow("ENOENT");
  });
});
