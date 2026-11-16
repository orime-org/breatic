// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Keeps the identity token fresh in a build with several regions
 * (inner#1955): the token lives sixty seconds, so it is renewed every 45, at
 * once when the tab comes back or the network returns (a hidden tab's timers
 * are slowed and a sleeping laptop's stop), and before a stream is opened.
 */

import type { RegionConfig } from '@web/data/api/regions';
import { ApiException } from '@web/data/api/types';

/** How often the identity token is renewed. */
export const IDENTITY_RENEW_INTERVAL_MS = 45_000;

let renewer: (() => Promise<unknown>) | null = null;
let renewedAt = 0;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Renew every interval, unless the timer already runs. */
function startTimer(): void {
  timer ??= setInterval(() => {
    void renewIdentityNow();
  }, IDENTITY_RENEW_INTERVAL_MS);
}

/** Stop renewing every interval. */
function stopTimer(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/**
 * Renew now, sharing one request among everyone who asks while it runs: the
 * timer, a stream about to open, and every request a region refused with
 * `identity_expired`. A failed renewal is left to the next tick or sender. One
 * the global region refuses with 401 means the session is gone: the timer
 * stops, while a stream or a refused request can still ask, and the first
 * renewal that works again, after a sign-in in another tab, restarts it.
 * @returns Once the renewal has answered.
 */
export function renewIdentityNow(): Promise<void> {
  const renew = renewer;
  if (renew === null) return Promise.resolve();
  inFlight ??= renew().then(
    () => {
      renewedAt = Date.now();
      if (renewer === renew) startTimer();
    },
    (err: unknown) => {
      if (err instanceof ApiException && err.status === 401) stopTimer();
    },
  ).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Wait until the identity token is fresh: at once when it was renewed within
 * the interval, otherwise after one renewal. Streams call this before they
 * open, since only axios requests retry after a region's `identity_expired`.
 * @returns Once the token is fresh, or at once with one region.
 */
export async function ensureFreshIdentity(): Promise<void> {
  if (renewer === null || Date.now() - renewedAt < IDENTITY_RENEW_INTERVAL_MS) return;
  await renewIdentityNow();
}

/**
 * Renew the identity token in the background while several regions exist.
 * The token was just issued with the session, so the clock starts now.
 * @param renew - Asks the global region for a new token.
 * @param config - The region table, or null.
 * @returns Stops the renewal.
 */
export function startIdentityRenewal(renew: () => Promise<unknown>, config: RegionConfig | null): () => void {
  if (config === null || Object.keys(config.regions).length < 2) return () => undefined;
  renewer = renew;
  renewedAt = Date.now();
  startTimer();
  /** Renew a stale token as soon as the tab or the network is back. */
  const onBack = (): void => {
    if (document.visibilityState === 'visible') void ensureFreshIdentity();
  };
  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('online', onBack);
  return () => {
    document.removeEventListener('visibilitychange', onBack);
    window.removeEventListener('online', onBack);
    if (renewer === renew) {
      renewer = null;
      stopTimer();
    }
  };
}
