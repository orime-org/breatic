// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The rules behind the in-window "can't reach" page (#1599, design 5.1, 5.3).
 * Chromium commits a failed main-frame load as an error entry at the failed
 * address; the client writes the page into that entry and retries by
 * reloading it in place. Kept apart from Electron so the rules can be tested.
 */

/** Automatic retry delays: 5 s doubling to a 60 s cap, as Mattermost's RELOAD_INTERVAL starts. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];

/** Stripe's hosts, where the payment flow leaves the server origin on purpose (design 7.1). */
const STRIPE_HOST = /(^|\.)stripe\.com$/;

/**
 * Network error codes that mean the user's network or this computer, not the shell:
 * offline, name resolution, refused, reset, timed out, unreachable, and certificate errors (-200 to -299).
 */
const ENVIRONMENT_CODES = new Set([-21, -100, -101, -102, -104, -105, -106, -109, -118, -130, -137, -138]);

/**
 * The delay before the next automatic retry.
 * @param failures - Retries that have failed since the page appeared.
 * @returns Milliseconds.
 */
export function retryDelay(failures: number): number {
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)]!;
}

/** One window's retry schedule. */
export interface RetryScheduler {
  /** A load failed (the first one or a retry): schedule the next retry after the backoff. */
  failed(): void;
  /** Retry now (the button, Reload, the online event), unless a retry is already in flight. */
  now(): void;
  /** The server answered: stop and reset the backoff. */
  succeeded(): void;
  /** The window left the error entry or closed: stop. */
  clear(): void;
}

/**
 * Create a window's retry schedule.
 * @param retry - Starts one retry (reloads the error entry in place).
 * @returns The scheduler.
 */
export function createRetryScheduler(retry: () => void): RetryScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let inFlight = false;

  /** Stop the pending timer, if any. */
  function stop(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Start one retry now. */
  function start(): void {
    stop();
    inFlight = true;
    retry();
  }

  return {
    failed(): void {
      // The first failure opens the page; each later one is a retry that ended, and doubles the wait.
      if (inFlight) failures += 1;
      const delay = retryDelay(failures);
      inFlight = false;
      stop();
      timer = setTimeout(start, delay);
    },
    now(): void {
      if (!inFlight) start();
    },
    succeeded(): void {
      stop();
      inFlight = false;
      failures = 0;
    },
    clear(): void {
      stop();
      inFlight = false;
      failures = 0;
    },
  };
}

/** What the main process sees of a `retry()` call. */
export interface RetryCall {
  isMainFrame: boolean;
  /** `senderFrame.origin`: "null" on Chromium's error entry. */
  origin: string;
  /** `senderFrame.url`: the failed address on the error entry. */
  url: string;
  /** The address this window last failed at, or null when it shows no "can't reach" page. */
  recordedUrl: string | null;
}

/**
 * Whether a `retry()` call comes from this window's error entry. An origin of
 * "null" alone is not enough: a page served with a sandbox CSP has one too.
 * @param call - The call as the main process sees it.
 * @returns True for the main frame of the error entry at the recorded address.
 */
export function acceptsRetry(call: RetryCall): boolean {
  return call.isMainFrame && call.recordedUrl !== null && call.origin === "null" && call.url === call.recordedUrl;
}

/** A response as `session.webRequest.onHeadersReceived` sees it. */
export interface RedirectResponse {
  resourceType: string;
  statusCode: number;
  /** The `Location` header, if any. */
  location: string | undefined;
  serverOrigin: string;
  /** Whether the main process is loading the server address in this window (start, new window, reopen, retry). */
  mainLoadInFlight: boolean;
}

/**
 * Whether to cancel a response: a main-issued server load redirected to
 * another origin (Stripe aside). Cancelling turns it into a plain load
 * failure, so Chromium commits an error entry at the server address.
 * @param response - The response.
 * @returns True to cancel it.
 */
export function blocksRedirect(response: RedirectResponse): boolean {
  if (!response.mainLoadInFlight || response.resourceType !== "mainFrame") return false;
  if (response.statusCode < 300 || response.statusCode >= 400 || !response.location) return false;
  let target: URL;
  try {
    target = new URL(response.location, response.serverOrigin);
  } catch {
    return false;
  }
  return target.origin !== response.serverOrigin && !STRIPE_HOST.test(target.hostname);
}

/**
 * Whether a load failure comes from the user's network or certificates, which
 * are logged as warnings and not reported.
 * @param errorCode - Chromium's network error code.
 * @returns True for network and certificate failures.
 */
export function isEnvironmentFailure(errorCode: number): boolean {
  return ENVIRONMENT_CODES.has(errorCode) || (errorCode <= -200 && errorCode > -300);
}
