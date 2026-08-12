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
 * `enterprise` is the ratified fourth tier ("商务谈" in the decision) and
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

/**
 * The quota fields a tier carries.
 *
 * Every one is a plain ceiling compared with `count >= limit`. There is no
 * "unlimited" value and no sentinel: a deployment that does not want to cap
 * something writes a number nobody reaches. That keeps zero meaning zero —
 * `base.team_studios` is 0 because that tier genuinely cannot create a team
 * studio, and the same comparison refuses it without a special case.
 */
export interface MembershipLimits {
  /** Team studios this account may administer at once. */
  team_studios: number;
  /** Projects one studio may hold. */
  projects_per_studio: number;
  /**
   * Simultaneous WRITABLE connections to one document. Connections, not
   * people: one account with four browser tabs open holds four of them.
   * (The ratified decision words this as "people", which is imprecise —
   * user 2026-08-12 confirmed connections is what is enforced.)
   */
  concurrent_editors: number;
  /** Active members one studio may have. */
  studio_members: number;
  /** People explicitly invited to one project. */
  project_members: number;
  /** Storage bytes, summed over the studios this account administers. */
  storage_bytes: number;
}
