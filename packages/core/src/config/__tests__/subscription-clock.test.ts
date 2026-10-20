// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The subscription clock never touches `config/subscription.yaml`.
 *
 * Every service that reads an account's tier goes through this clock: server
 * at sign-in, collab when it sizes a document's editor seats. That file holds
 * a deployment's prices and is mounted into server alone, so the renewal
 * window lives in `config/membership.yaml`, which every image carries
 * (inner#1636).
 */

import type * as Fs from "node:fs";
import { describe, it, expect, vi } from "vitest";

const readFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  // Only config/subscription.yaml is absent, as in a collab container: the
  // deployment mounts it into server alone.
  readFileSync.mockImplementation((...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).endsWith("config/subscription.yaml")) {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    }
    return actual.readFileSync(...args);
  });
  return { ...actual, readFileSync };
});

import { subscriptionClock } from "@core/config/subscription.js";
import { subscriptionSituation } from "@core/auth/subscription-state.js";

describe("subscriptionClock without config/subscription.yaml (#307, inner#1636)", () => {
  it("reads an account with no subscription rows without opening the file", () => {
    const reading = subscriptionSituation([], subscriptionClock());

    expect(reading.situation).toBe("none");
    expect(reading.lapsed).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("takes the renewal window from config/membership.yaml without opening config/subscription.yaml", () => {
    const clock = subscriptionClock();

    expect(clock.staleAfterMs).toBe(14 * 24 * 60 * 60 * 1000);
    const opened = readFileSync.mock.calls.map((call) => String(call[0]));
    expect(opened.some((path) => path.endsWith("config/subscription.yaml"))).toBe(false);
  });
});
