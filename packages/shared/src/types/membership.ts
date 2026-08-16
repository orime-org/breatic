// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Membership tiers (ratified 2026-07-30).
 *
 * A tier decides capacity and collaboration scale — how much storage, how
 * many team studios, projects, members, and simultaneous writable
 * connections. It never decides what a person can create: every generation
 * feature and every model is available on every tier.
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
 * The tiers an account can be on.
 *
 * The first three are the ratified priced tiers. `self_hosted` is a
 * deployment shape rather than an entry on the price list: whoever runs a
 * self-hosted install gets the numbers written in that install's
 * `config/membership.yaml`, and tightens them by editing that file.
 * `enterprise` is the negotiated one, agreed per customer.
 *
 * This is every tier a `users.membership_tier` row may legally hold, and the
 * database's CHECK constraint lists exactly these five. It is NOT the set of
 * tiers whose ceilings come out of the config file — that is
 * {@link CONFIGURED_MEMBERSHIP_TIERS}, and the two are different on purpose.
 */
export const MEMBERSHIP_TIERS = [
  "base",
  "pro",
  "team",
  "self_hosted",
  "enterprise",
] as const;

/** One of the tiers an account can be on. */
export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

/**
 * The tiers whose ceilings are written in `config/membership.yaml`.
 *
 * Enterprise is absent, and that absence is the whole point. Its numbers are
 * agreed per customer, so there is no single set of them to put in a config
 * file; they will be read from the database when that work happens. Writing a
 * set before then would hand an account put on that tier a quota nobody
 * negotiated, and nothing would surface it.
 *
 * So the tier is legal to store and impossible to price: the constraint
 * accepts the word, and asking for its ceilings fails loudly, naming the
 * account. Narrowing every ceiling lookup to this subset is what makes the
 * compiler insist that each one says out loud what it does about enterprise,
 * rather than indexing a config object and getting `undefined`.
 */
export const CONFIGURED_MEMBERSHIP_TIERS = [
  "base",
  "pro",
  "team",
  "self_hosted",
] as const;

/** A tier whose ceilings can be read from `config/membership.yaml`. */
export type ConfiguredMembershipTier =
  (typeof CONFIGURED_MEMBERSHIP_TIERS)[number];

// The ceilings each tier carries are NOT here. They are the shape of
// `config/membership.yaml`, they are read only by the services that enforce
// them, and web has no use for them until there is a membership page to
// render — which is a separate piece of work. By this package's own entry
// test ("does web need it?") they belong beside the loader, in core.
