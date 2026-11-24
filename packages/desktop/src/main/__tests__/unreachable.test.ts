// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rules behind the in-window "can't reach" page (inner#2041, design 5.1, 5.3):
 * the retry schedule, which calls may ask for a retry, which redirects of a
 * main-issued server load are turned into a plain load failure, and which
 * failures are the user's environment rather than the shell's own fault.
 */

import { describe, it, expect, vi } from "vitest";

import {
  acceptsRetry,
  createLoadTracker,
  createRetryScheduler,
  isEnvironmentFailure,
  redirectAway,
  retryDelay,
  type LoadTracker,
  type ShownUnreachable,
} from "@desktop/main/unreachable.js";

describe("retryDelay", () => {
  it("starts at 5 s and doubles to a 60 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
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

  it("retries at once when asked, and stops everything when cleared", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    scheduler.now();
    expect(retry).toHaveBeenCalledTimes(1);
    scheduler.clear();
    vi.advanceTimersByTime(120_000);
    expect(retry).toHaveBeenCalledTimes(1);
    scheduler.failed();
    scheduler.clear();
    vi.advanceTimersByTime(120_000);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("waits for a retry the user started with Reload, and doubles the wait when it fails", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    vi.advanceTimersByTime(1_000);
    scheduler.started();
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
    scheduler.now();
    expect(retry).not.toHaveBeenCalled();
    scheduler.failed();
    vi.advanceTimersByTime(9_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("starts a new schedule at 5 s after it was cleared", () => {
    const { scheduler, retry } = setup();
    scheduler.failed();
    vi.advanceTimersByTime(5_000);
    scheduler.failed();
    scheduler.clear();
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

describe("redirectAway", () => {
  const base = { statusCode: 302, serverOrigin: "https://studio.example.test", mainLoadInFlight: true };

  it.each([
    ["another origin", "https://www.other.test/x?token=SECRET", "https://www.other.test/x"],
    ["a page of the server outside the app", "/oauth2/sign_in?rd=%2Fstudio", "https://studio.example.test/oauth2/sign_in"],
    ["Stripe over plain HTTP", "http://checkout.stripe.com/c/pay", "http://checkout.stripe.com/c/pay"],
  ])("cancels a main-issued server load redirected to %s, giving where it went without its query", (_label, location, target) => {
    expect(redirectAway({ ...base, location })).toBe(target);
  });

  it.each([
    ["an app page of the server", { ...base, location: "https://studio.example.test/login?next=%2Fstudio" }],
    ["a relative app page", { ...base, location: "/login" }],
    ["Stripe", { ...base, location: "https://checkout.stripe.com/c/pay" }],
    ["an in-app navigation", { ...base, location: "https://www.other.test/x", mainLoadInFlight: false }],
    ["a response that is not a redirect", { ...base, location: "https://www.other.test/x", statusCode: 200 }],
    ["a response without a location", { ...base, location: undefined }],
  ])("lets through %s", (_label, response) => {
    expect(redirectAway(response)).toBeNull();
  });
});

describe("isEnvironmentFailure", () => {
  it.each([
    [-106, "internet disconnected"],
    [-105, "name not resolved"],
    [-102, "connection refused"],
    [-118, "connection timed out"],
    [-7, "timed out"],
    [-12, "network IO suspended"],
    [-21, "network changed"],
    [-103, "connection aborted"],
    [-107, "SSL protocol error"],
    [-111, "tunnel connection failed (proxy)"],
    [-120, "SOCKS connection failed"],
    [-202, "certificate authority invalid"],
  ])("treats %i (%s) as the user's environment", (code) => {
    expect(isEnvironmentFailure(code)).toBe(true);
  });

  it("treats other failures as the shell's own", () => {
    expect(isEnvironmentFailure(-20)).toBe(false);
    expect(isEnvironmentFailure(-3)).toBe(false);
    expect(isEnvironmentFailure(-324)).toBe(false);
  });
});

describe("createLoadTracker", () => {
  const SERVER = "https://studio.example.test";
  const STUDIO = `${SERVER}/studio`;

  /** A tracker over fake timers, with every effect recorded. */
  function setup(): {
    tracker: LoadTracker;
    reload: ReturnType<typeof vi.fn>;
    renders: { shown: ShownUnreachable; busy: boolean }[];
    logs: { level: string; errorCode: number; url: string }[];
  } {
    vi.useFakeTimers();
    const reload = vi.fn();
    const renders: { shown: ShownUnreachable; busy: boolean }[] = [];
    const logs: { level: string; errorCode: number; url: string }[] = [];
    const tracker = createLoadTracker({
      serverOrigin: SERVER,
      reload,
      render: (shown, busy) => renders.push({ shown, busy }),
      log: (level, entry) => logs.push({ level, ...entry }),
    });
    return { tracker, reload, renders, logs };
  }

  /** The events of a main-issued load of STUDIO that fails with a code. */
  function failMainLoad(tracker: LoadTracker, errorCode: number): void {
    tracker.mainLoadStarted();
    tracker.navigationStarted({ url: STUDIO, isMainFrame: true, isSameDocument: false });
    tracker.loadFailed({ url: STUDIO, errorCode, isMainFrame: true });
    tracker.loadFinished();
  }

  it("shows a failed main-frame load of the server once its error entry has loaded, and reports it once", () => {
    const { tracker, renders, logs } = setup();
    failMainLoad(tracker, -324);
    expect(renders).toEqual([{ shown: { url: STUDIO, reason: { kind: "unreachable" } }, busy: false }]);
    expect(tracker.shown()).toEqual({ url: STUDIO, reason: { kind: "unreachable" } });
    expect(logs).toEqual([{ level: "error", errorCode: -324, url: STUDIO }]);
    vi.useRealTimers();
  });

  it("retries after 5 s by reloading the entry in place, and logs a failed retry as a warning", () => {
    const { tracker, reload, renders, logs } = setup();
    failMainLoad(tracker, -324);
    vi.advanceTimersByTime(5_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(renders.at(-1)).toEqual({ shown: { url: STUDIO, reason: { kind: "unreachable" } }, busy: true });
    tracker.navigationStarted({ url: STUDIO, isMainFrame: true, isSameDocument: false });
    tracker.loadFailed({ url: STUDIO, errorCode: -324, isMainFrame: true });
    tracker.loadFinished();
    expect(logs.map((entry) => entry.level)).toEqual(["error", "warn"]);
    expect(renders.at(-1)?.busy).toBe(false);
    vi.advanceTimersByTime(9_999);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("logs the user's network and certificate failures as warnings, with the certificate reason", () => {
    const { tracker, renders, logs } = setup();
    failMainLoad(tracker, -202);
    expect(renders[0]?.shown.reason).toEqual({ kind: "certificate" });
    expect(logs).toEqual([{ level: "warn", errorCode: -202, url: STUDIO }]);
    vi.useRealTimers();
  });

  it("shows where a cancelled redirect went", () => {
    const { tracker, renders } = setup();
    tracker.mainLoadStarted();
    tracker.navigationStarted({ url: STUDIO, isMainFrame: true, isSameDocument: false });
    tracker.redirectCancelled("https://www.other.test/x");
    tracker.loadFailed({ url: STUDIO, errorCode: -20, isMainFrame: true });
    tracker.loadFinished();
    expect(renders[0]?.shown.reason).toEqual({ kind: "redirected", target: "https://www.other.test/x" });
    vi.useRealTimers();
  });

  it("treats Reload on the error entry as a retry: busy at once, and the schedule waits for it", () => {
    const { tracker, reload, renders } = setup();
    failMainLoad(tracker, -102);
    vi.advanceTimersByTime(1_000);
    tracker.navigationStarted({ url: STUDIO, isMainFrame: true, isSameDocument: false });
    expect(renders.at(-1)?.busy).toBe(true);
    expect(tracker.mainLoadInFlight()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("stops retrying once the server answers, and draws nothing more", () => {
    const { tracker, reload, renders } = setup();
    failMainLoad(tracker, -102);
    vi.advanceTimersByTime(5_000);
    tracker.navigationStarted({ url: STUDIO, isMainFrame: true, isSameDocument: false });
    tracker.loadFinished();
    const drawn = renders.length;
    expect(tracker.shown()).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(renders).toHaveLength(drawn);
    vi.useRealTimers();
  });

  it("stops when the user leaves the error entry for another page", () => {
    const { tracker, reload } = setup();
    failMainLoad(tracker, -102);
    tracker.navigationStarted({ url: `${SERVER}/login`, isMainFrame: true, isSameDocument: false });
    expect(tracker.shown()).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("counts a retry that neither failed nor showed a page (a 204) as failed, and goes on", () => {
    const { tracker, reload, renders } = setup();
    failMainLoad(tracker, -102);
    vi.advanceTimersByTime(5_000);
    tracker.navigationStarted({ url: STUDIO, isMainFrame: true, isSameDocument: false });
    tracker.loadStopped();
    expect(renders.at(-1)?.busy).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("ignores failures that are not a main-frame load of the server", () => {
    const { tracker, renders, logs } = setup();
    tracker.loadFailed({ url: STUDIO, errorCode: -102, isMainFrame: false });
    tracker.loadFailed({ url: "https://checkout.stripe.com/x", errorCode: -102, isMainFrame: true });
    tracker.loadFailed({ url: STUDIO, errorCode: -3, isMainFrame: true });
    tracker.loadFinished();
    expect(renders).toEqual([]);
    expect(logs).toEqual([]);
    vi.useRealTimers();
  });

  it("retries at once when the error entry asks, and only then", () => {
    const { tracker, reload } = setup();
    tracker.retryAsked({ isMainFrame: true, origin: "null", url: STUDIO });
    expect(reload).not.toHaveBeenCalled();
    failMainLoad(tracker, -102);
    tracker.retryAsked({ isMainFrame: true, origin: SERVER, url: STUDIO });
    expect(reload).not.toHaveBeenCalled();
    tracker.retryAsked({ isMainFrame: true, origin: "null", url: STUDIO });
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("hears about the first finished load once", () => {
    const { tracker } = setup();
    const first = vi.fn();
    tracker.onFirstLoad(first);
    failMainLoad(tracker, -102);
    tracker.loadFinished();
    expect(first).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("schedules nothing after the window closed", () => {
    const { tracker, reload } = setup();
    failMainLoad(tracker, -102);
    tracker.closed();
    vi.advanceTimersByTime(120_000);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
