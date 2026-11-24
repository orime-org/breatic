// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The in-window "can't reach" page (inner#2041, design 5.1, 5.3): which loads
 * end in it, the retry schedule, and which failures are reported. Chromium
 * commits a failed main-frame load as an error entry at the failed address;
 * the client writes the page into that entry and retries by reloading it in
 * place. As in Chromium's own NetErrorHelperCore, the state changes when a
 * navigation commits (the error entry with `did-fail-provisional-load`, a
 * page with `did-navigate`); a navigation that ends without committing leaves
 * the window on the error entry, and the online event's retry waits while a
 * navigation is pending. Kept apart from Electron so the transitions can
 * be tested; the main process feeds it the window's load events.
 */

import { addressWithoutQuery } from "@breatic/shared";
import { decideNavigation, isCertificateError, isServerLoadFailure } from "@desktop/main/navigation.js";

/** Why a window shows "can't reach" (design 6.2). */
export type UnreachableReason = { kind: "unreachable" } | { kind: "certificate" } | { kind: "redirected"; target: string };

/** The address that failed and why. */
export interface ShownUnreachable {
  url: string;
  reason: UnreachableReason;
}

/**
 * The delay before the next automatic retry: 5 s doubling to a 60 s cap, as Mattermost's RELOAD_INTERVAL starts.
 * @param failures - Retries that have failed since the page appeared.
 * @returns Milliseconds.
 */
export function retryDelay(failures: number): number {
  return Math.min(5_000 * 2 ** failures, 60_000);
}

/** One window's retry schedule. */
export interface RetryScheduler {
  /** A load failed (the first one or a retry): schedule the next retry after the backoff. */
  failed(): void;
  /** Retry now (the button, the online event), unless a retry is already in flight. */
  now(): void;
  /** A retry started outside the scheduler (the user pressed Reload on the error entry): wait for it. */
  started(): void;
  /** The server answered, a navigation started to leave the error entry, or the window closed: stop and reset the backoff. */
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
    started(): void {
      stop();
      inFlight = true;
    },
    clear(): void {
      stop();
      inFlight = false;
      failures = 0;
    },
  };
}

/**
 * Whether a frame is the error entry of the address a window last failed at.
 * An origin of "null" alone is not enough: a page served with a sandbox CSP has one too.
 * @param frame - The frame as the main process sees it.
 * @param frame.origin - Its origin: "null" on Chromium's error entry.
 * @param frame.url - Its URL: the failed address on the error entry.
 * @param recordedUrl - The address the window failed at, or null when it shows no "can't reach" page.
 * @returns True for the error entry at the recorded address.
 */
export function isErrorEntry(frame: { origin: string; url: string }, recordedUrl: string | null): boolean {
  return recordedUrl !== null && frame.origin === "null" && frame.url === recordedUrl;
}

/** A main-frame response of the server, as `session.webRequest.onHeadersReceived` sees it. */
export interface RedirectResponse {
  statusCode: number;
  /** The `Location` header, if any. */
  location: string | undefined;
  serverOrigin: string;
  /** Whether the main process is loading the server address in this window (start, new window, reopen, retry). */
  mainLoadInFlight: boolean;
}

/**
 * Where a main-issued server load is redirected when that redirect would not
 * stay in the window (the rules of `decideNavigation`). Cancelling it turns it
 * into a plain load failure, so Chromium commits an error entry at the server address.
 * @param response - The response.
 * @returns The target without its query, to cancel; null to let it through.
 */
export function redirectAway(response: RedirectResponse): string | null {
  if (!response.mainLoadInFlight || !response.location) return null;
  if (response.statusCode < 300 || response.statusCode >= 400) return null;
  let target: URL;
  try {
    target = new URL(response.location, response.serverOrigin);
  } catch {
    return null;
  }
  if (decideNavigation({ url: target.href, currentUrl: "", serverOrigin: response.serverOrigin }) === "allow") return null;
  return addressWithoutQuery(target.href);
}

/**
 * Whether a load failure comes from the user's network or certificates, which
 * are logged as warnings and not reported: timed out (-7), network changed
 * (-21), network IO suspended (-331, the computer slept), and Chromium's
 * connection (-100 to -199) and certificate (-200 to -299) ranges
 * (`net/base/net_error_list.h`).
 * @param errorCode - Chromium's network error code.
 * @returns True for network and certificate failures.
 */
export function isEnvironmentFailure(errorCode: number): boolean {
  return errorCode === -7 || errorCode === -21 || errorCode === -331 || (errorCode <= -100 && errorCode > -200) || isCertificateError(errorCode);
}

/** What a window's load tracker does to the window. */
export interface LoadTrackerDeps {
  serverOrigin: string;
  /** Reload the window's current entry in place. */
  reload(): void;
  /** Write "can't reach" into the window's error entry. */
  render(shown: ShownUnreachable, busy: boolean): void;
  /** Log a failed server load. */
  log(level: "warn" | "error", entry: { errorCode: number; url: string }): void;
}

/** One app window's loads and its "can't reach" state, fed by the window's load events. */
export interface LoadTracker {
  /** The main process starts loading a server address (start, new window, reopen). */
  mainLoadStarted(): void;
  /** Whether a load the main process issued is in flight, so a redirect of it away is cancelled. */
  mainLoadInFlight(): boolean;
  /** The current main load's redirect to `target` was cancelled. */
  redirectCancelled(target: string): void;
  /** `did-start-navigation`. */
  navigationStarted(nav: { url: string; isMainFrame: boolean; isSameDocument: boolean }): void;
  /** `did-fail-provisional-load`: Chromium's error entry has committed (`did-fail-load` also fires when a committed page's body fails). */
  loadFailed(failure: { url: string; errorCode: number; isMainFrame: boolean }): void;
  /** `did-navigate`: a page has committed in the main frame. */
  pageCommitted(): void;
  /** `did-finish-load`. */
  loadFinished(): void;
  /** `did-stop-loading`. */
  loadStopped(): void;
  /**
   * The page called `retry()`; honoured only from the error entry's main frame.
   * An automatic one (the online event) waits while a navigation is pending, as Chromium's auto-reload does.
   */
  retryAsked(frame: { isMainFrame: boolean; origin: string; url: string }, automatic: boolean): void;
  /** Run once when the window's first load ends. */
  onFirstLoad(listener: () => void): void;
  /** The window closed. */
  closed(): void;
}

/**
 * Create a window's load tracker.
 * @param deps - What it does to the window.
 * @returns The tracker.
 */
export function createLoadTracker(deps: LoadTrackerDeps): LoadTracker {
  /** The address that failed and why, while the window is on its error entry. */
  let shown: ShownUnreachable | null = null;
  /** The error entry has committed and waits for its document to load before the page is written. */
  let pendingRender = false;
  /** This run of "can't reach" has sent its one report. */
  let reported = false;
  let mainLoad = false;
  /** The current navigation has ended in success or failure. */
  let settled = true;
  let redirectTarget: string | null = null;
  let firstLoad: (() => void) | null = null;
  const scheduler = createRetryScheduler(retry);

  /** Retry the failed address: reload the error entry in place. */
  function retry(): void {
    mainLoad = true;
    redirectTarget = null;
    if (shown) deps.render(shown, true);
    deps.reload();
  }

  /** The current navigation has ended. */
  function endNavigation(): void {
    settled = true;
    mainLoad = false;
    redirectTarget = null;
    const listener = firstLoad;
    firstLoad = null;
    listener?.();
  }

  return {
    mainLoadStarted(): void {
      mainLoad = true;
      redirectTarget = null;
    },
    mainLoadInFlight(): boolean {
      return mainLoad;
    },
    redirectCancelled(target): void {
      redirectTarget = target;
    },
    navigationStarted({ url, isMainFrame, isSameDocument }): void {
      if (!isMainFrame || isSameDocument) return;
      settled = false;
      if (!shown || mainLoad) return;
      if (url === shown.url) {
        // Reload on the error entry (the menu, Cmd+R) is a retry.
        scheduler.started();
        mainLoad = true;
        redirectTarget = null;
        deps.render(shown, true);
      } else {
        // Back, Forward or a link: the window leaves the error entry once that navigation commits; if it does not, retries start again from 5 s.
        scheduler.clear();
      }
    },
    loadFailed({ url, errorCode, isMainFrame }): void {
      if (!isServerLoadFailure({ url, serverOrigin: deps.serverOrigin, isMainFrame, errorCode })) return;
      const reason: UnreachableReason = redirectTarget
        ? { kind: "redirected", target: redirectTarget }
        : isCertificateError(errorCode)
          ? { kind: "certificate" }
          : { kind: "unreachable" };
      shown = { url, reason };
      pendingRender = true;
      // The user's network and certificates are logged only; anything else is reported once per run of "can't reach".
      const level = isEnvironmentFailure(errorCode) || reported ? "warn" : "error";
      if (level === "error") reported = true;
      deps.log(level, { errorCode, url: addressWithoutQuery(url) });
    },
    pageCommitted(): void {
      shown = null;
      pendingRender = false;
      reported = false;
      scheduler.clear();
    },
    loadFinished(): void {
      if (shown && pendingRender) {
        // The error entry's document has loaded: write "can't reach" into it and schedule the next retry.
        pendingRender = false;
        deps.render(shown, false);
        scheduler.failed();
      }
      endNavigation();
    },
    loadStopped(): void {
      if (settled) return;
      // A navigation that ended without committing (a 204, a download, a cancelled Back) leaves the window on the error entry.
      if (shown) {
        deps.render(shown, false);
        scheduler.failed();
      }
      endNavigation();
    },
    retryAsked(frame, automatic): void {
      if (automatic && !settled) return;
      if (frame.isMainFrame && isErrorEntry(frame, shown?.url ?? null)) scheduler.now();
    },
    onFirstLoad(listener): void {
      firstLoad = listener;
    },
    closed(): void {
      scheduler.clear();
    },
  };
}
