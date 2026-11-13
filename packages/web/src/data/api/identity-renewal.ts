// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Keeps the identity token fresh in a build with several regions
 * (inner#1955): the token lives sixty seconds, so it is renewed every 45.
 */

import type { RegionConfig } from '@web/data/api/regions';

/** How often the identity token is renewed. */
export const IDENTITY_RENEW_INTERVAL_MS = 45_000;

/**
 * Renew the identity token in the background while several regions exist.
 * @param renew - Asks the global region for a new token.
 * @param config - The region table, or null.
 * @returns Stops the renewal.
 */
export function startIdentityRenewal(renew: () => Promise<unknown>, config: RegionConfig | null): () => void {
  if (config === null || Object.keys(config.regions).length < 2) return () => undefined;
  const timer = setInterval(() => {
    // A failed renewal is retried on the next tick, and a region's
    // identity_expired answer renews once more before the request fails.
    renew().catch(() => undefined);
  }, IDENTITY_RENEW_INTERVAL_MS);
  return () => clearInterval(timer);
}
