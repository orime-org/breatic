// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rules behind the in-window "can't reach" page (#1599, design 5.1, 5.3):
 * the retry schedule, which calls may ask for a retry, which redirects of a
 * main-issued server load are turned into a plain load failure, and which
 * failures are the user's environment rather than the shell's own fault.
 */

import { describe, it, expect, vi } from "vitest";

import {
  RETRY_DELAYS_MS,
  acceptsRetry,
  blocksRedirect,
  createRetryScheduler,
  isEnvironmentFailure,
  retryDelay,
} from "@desktop/main/unreachable.js";

describe("retryDelay", () => {
  it("starts at 5 s and doubles to a 60 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(RETRY_DELAYS_MS[0]).toBe(5_000);
  });
});

describe("createRetryScheduler", () => {
  /**
   * A scheduler over fake timers.
   * @returns The scheduler and its retry spy.
   */
  function setup(): { scheduler: ReturnType<typeof createRetryScheduler>; retry: ReturnType<typeof vi.fn> } {
    vi.useFakeTimers();
    const retry = vi.fn();
    return { scheduler: createRetryScheduler(retry), retry };
  }

  it("retries after the backoff and keeps doubling while retries fail", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    vi.advanceTimersByTime(4_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    scheduler.failed();
    vi.advanceTimersByTime(9_999);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("never schedules a second retry while one is in flight", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    vi.advanceTimersByTime(5_000);
    scheduler.now();
    scheduler.now();
    expect(retry).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("retries at once when asked, and stops everything on success or when cleared", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    scheduler.now();
    expect(retry).toHaveBeenCalledTimes(1);
    scheduler.succeeded();
    vi.advanceTimersByTime(120_000);
    expect(retry).toHaveBeenCalledTimes(1);
    scheduler.failed();
    scheduler.clear();
    vi.advanceTimersByTime(120_000);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("starts a new schedule at 5 s after a success", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    vi.advanceTimersByTime(5_000);
    scheduler.failed();
    scheduler.succeeded();
    scheduler.failed();
    vi.advanceTimersByTime(5_000);
    expect(retry).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("acceptsRetry", () => {
  const recorded = "https://studio.example.test/project/1";

  it("accepts the main frame of the error entry at the recorded address", () => {
    expect(acceptsRetry({ isMainFrame: true, origin: "null", url: recorded, recordedUrl: recorded })).toBe(true);
  });

  it.each([
    ["no unreachable state", { isMainFrame: true, origin: "null", url: recorded, recordedUrl: null }],
    ["a subframe", { isMainFrame: false, origin: "null", url: recorded, recordedUrl: recorded }],
    ["the server page itself", { isMainFrame: true, origin: "https://studio.example.test", url: recorded, recordedUrl: recorded }],
    ["a sandboxed page elsewhere", { isMainFrame: true, origin: "null", url: "https://evil.test/", recordedUrl: recorded }],
  ])("refuses %s", (_label, call) => {
    expect(acceptsRetry(call)).toBe(false);
  });
});

describe("blocksRedirect", () => {
  const base = { resourceType: "mainFrame", statusCode: 302, serverOrigin: "https://studio.example.test", mainLoadInFlight: true };

  it("blocks a main-issued server load redirected to another origin", () => {
    expect(blocksRedirect({ ...base, location: "https://www.other.test/x" })).toBe(true);
  });

  it.each([
    ["a redirect within the server origin", { ...base, location: "https://studio.example.test/login" }],
    ["a relative redirect", { ...base, location: "/login" }],
    ["a redirect to Stripe", { ...base, location: "https://checkout.stripe.com/c/pay" }],
    ["an in-app navigation", { ...base, location: "https://www.other.test/x", mainLoadInFlight: false }],
    ["a subresource", { ...base, location: "https://www.other.test/x", resourceType: "xhr" }],
    ["a response that is not a redirect", { ...base, location: "https://www.other.test/x", statusCode: 200 }],
  ])("lets through %s", (_label, response) => {
    expect(blocksRedirect(response)).toBe(false);
  });
});

describe("isEnvironmentFailure", () => {
  it.each([
    [-106, "internet disconnected"],
    [-105, "name not resolved"],
    [-102, "connection refused"],
    [-118, "connection timed out"],
    [-202, "certificate authority invalid"],
  ])("treats %i (%s) as the user's environment", (code) => {
    expect(isEnvironmentFailure(code)).toBe(true);
  });

  it("treats other failures as the shell's own", () => {
    expect(isEnvironmentFailure(-20)).toBe(false);
    expect(isEnvironmentFailure(-3)).toBe(false);
  });
});
