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
 * The tiers an account can currently be on.
 *
 * The first three are the ratified priced tiers. `self_hosted` is a
 * deployment shape rather than an entry on the price list: whoever runs a
 * self-hosted install gets the numbers written in that install's
 * `config/membership.yaml`, and tightens them by editing that file.
 *
 * The product has a fifth category — enterprise, the negotiated one — and it
 * is deliberately absent here. Its numbers are agreed per customer, so there
 * is no single set of them to put in a config file; they will be read from
 * the database when that work happens, and this enum gains the value then.
 *
 * Leaving it out is the safe direction, not the lazy one. Present in the
 * enum, the tier would need numbers in the config file today, and those
 * numbers would be invented: an account put on it would silently receive a
 * ceiling nobody negotiated. Absent from the enum, the same attempt fails
 * loudly.
 */
export const MEMBERSHIP_TIERS = ["base", "pro", "team", "self_hosted"] as const;

/** One of the tiers an account can be on. */
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

// The ceilings each tier carries are NOT here. They are the shape of
// `config/membership.yaml`, they are read only by the services that enforce
// them, and web has no use for them until there is a membership page to
// render — which is a separate piece of work. By this package's own entry
// test ("does web need it?") they belong beside the loader, in core.
