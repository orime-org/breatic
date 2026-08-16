// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ComparableMembershipTier } from '@breatic/shared';

/**
 * What each priced tier costs per month, in US dollars.
 *
 * These are ratified numbers, and they are here rather than in
 * `config/membership.yaml` because that file holds ceilings only. When the
 * checkout work lands it will need a price the payment provider agrees with,
 * and settling where that single source lives belongs with it — until then
 * this is the one place the panel reads them from, so there is one thing to
 * move rather than several.
 */
export const TIER_MONTHLY_PRICE_USD: Readonly<
  Record<ComparableMembershipTier, number>
> = {
  base: 0,
  pro: 12,
  team: 39,
};

/** Where an account goes to negotiate terms we do not put on a price list. */
export const SALES_EMAIL = 'breatic@orime.ai';
