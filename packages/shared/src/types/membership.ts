// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Membership tiers (ratified 2026-07-30).
 *
 * A tier decides capacity and collaboration scale — how much storage, how
 * many team studios, projects, members, and simultaneous writable
 * connections. It never decides what a person can create: every generation
 * feature and every model is available on all four tiers.
 *
 * The tier lives on the account. Which tier governs a studio's limits is a
 * separate question with a settled answer: the tier of that studio's current
 * admin, so a transfer moves the studio onto the new admin's tier.
 *
 * Not to be confused with the `tier` already in this codebase around
 * payments (`config/pricing.yaml`, `payment.service.ts`) — those are credit
 * PACKS, an unrelated leg of the product. Membership is always spelled out
 * as `membershipTier` in code for that reason.
 */

/**
 * The four tiers.
 *
 * `enterprise` is the ratified fourth tier — the negotiated one — and
 * carries two kinds of deployment on purpose: negotiated customers on our
 * hosted service, and every account on a self-hosted install. What they
 * have in common is that their numbers do not come from our price list —
 * they come from whoever runs that deployment. This is deliberate, not a
 * leftover: anyone tempted to "clean up" the double duty should read this
 * paragraph first.
 */
export const MEMBERSHIP_TIERS = ["base", "pro", "team", "enterprise"] as const;

/** One of the four membership tiers. */
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

// The ceilings each tier carries are NOT here. They are the shape of
// `config/membership.yaml`, they are read only by the services that enforce
// them, and web has no use for them until there is a membership page to
// render — which is a separate piece of work. By this package's own entry
// test ("does web need it?") they belong beside the loader, in core.
