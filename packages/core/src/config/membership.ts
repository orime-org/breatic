// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Membership quota configuration loader.
 *
 * Reads `config/membership.yaml`: which tier a new account lands in, and the
 * six ceilings each of the four configured tiers carries.
 *
 * Four, not five. An account may also be on `enterprise`, whose ceilings are
 * negotiated per customer and will come from the database — writing a set of
 * them here would hand such an account a quota nobody agreed to. Everything in
 * this file therefore speaks `ConfiguredMembershipTier`, which leaves that
 * tier out, so no caller can reach a ceiling for it by accident.
 *
 * Lives in core rather than beside the other business limits in server,
 * because three services need it: server enforces four of the ceilings,
 * collab enforces the concurrency one, and worker enforces the storage one
 * on the generation path. Neither collab nor worker may import server.
 *
 * Unlike the sibling loaders in this directory, **no field has a default**. A
 * quota that silently falls back to a number we invented would leave the
 * operator believing the value they wrote in the file is the one being
 * enforced; a loud failure will not.
 *
 * Nothing reads this file at boot, so that failure lands on the first caller
 * that needs it — a registration, or a quota check. What keeps a broken file
 * out of production is CI: the config test loads this very file and asserts
 * its contents, and config/ is copied into the image, so a change to it goes
 * through CI by construction. Warming every lazily loaded config at startup
 * is worth doing for self-hosted installs, which edit their own copy outside
 * our CI, but it belongs in one mechanism covering all of them rather than a
 * block bolted onto this one.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  CONFIGURED_MEMBERSHIP_TIERS,
  type ConfiguredMembershipTier,
} from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

/**
 * One ceiling.
 *
 * A plain non-negative integer, always compared as `count >= limit`. There is
 * no "unlimited" value and no sentinel — a deployment that does not want to
 * cap something writes a number nobody reaches (9999, or 100 TiB for bytes).
 * That is what keeps zero meaning zero: `base.team_studios` is 0 because that
 * tier genuinely cannot create a team studio, and the same comparison refuses
 * it without a special case anywhere.
 */
const limitSchema = z.number().int().nonnegative();

/**
 * The six ceilings every tier carries.
 *
 * `concurrent_editors` counts simultaneous WRITABLE CONNECTIONS to one
 * document, not people: one account with four browser tabs open holds four of
 * them. The ratified decision words this as "people", which is imprecise —
 * user 2026-08-12 confirmed connections is what gets enforced, and that the
 * decision's wording is what needs correcting.
 *
 * Field names are the YAML's, so this shape and the file cannot drift.
 */
const tierLimitsSchema = z.object({
  team_studios: limitSchema,
  projects_per_studio: limitSchema,
  concurrent_editors: limitSchema,
  studio_members: limitSchema,
  project_members: limitSchema,
  storage_bytes: limitSchema,
});

/**
 * One tier's ceilings.
 *
 * Inferred from the schema rather than declared beside it, so there is no
 * second list of field names to fall out of step with the first.
 *
 * Not in `@breatic/shared`: web has no use for these until there is a
 * membership page to render, which is separate work. They are the shape of a
 * config file the backend services read, so they live beside the loader.
 */
export type MembershipLimits = z.infer<typeof tierLimitsSchema>;

/** Schema for `config/membership.yaml`. */
export const membershipConfigSchema = z.object({
  /**
   * Which tier a newly registered account lands in.
   *
   * This one field is what makes a deployment ours or somebody else's: we
   * ship `base` and let people pay their way up; a self-hosted install ships
   * `self_hosted` and fills that tier's numbers itself. No separate
   * "self-hosted mode" switch exists, because this field already says it.
   *
   * It is applied at registration, in `createUser`. The column's own default
   * (`base`) exists for the rows the migration found already there, and is
   * not a fallback for new accounts — leaving it to do that job is what makes
   * this field inert, which is exactly the state Gate 2 caught.
   *
   * `enterprise` is not among the accepted values. A deployment that named it
   * here would put every new account on a tier with no ceilings to read, so
   * every quota check would throw; refusing it while loading the file says so
   * once, at the point somebody can still fix it.
   */
  default_tier: z.enum(CONFIGURED_MEMBERSHIP_TIERS),
  tiers: z.object({
    base: tierLimitsSchema,
    pro: tierLimitsSchema,
    team: tierLimitsSchema,
    self_hosted: tierLimitsSchema,
  }),
});

/** Validated membership configuration. */
export type MembershipConfig = z.infer<typeof membershipConfigSchema>;

let _cached: Readonly<MembershipConfig> | null = null;

/**
 * Load the membership configuration from YAML.
 *
 * Memoized, and read lazily: the first caller pays for the read and is the
 * one that sees a parse error. No service entry loads it at boot.
 * @returns Frozen, validated config
 * @throws {z.ZodError} if any tier is missing a field, or a value is negative
 *   or fractional
 * @throws {Error} if `config/membership.yaml` cannot be read
 */
export function getMembershipConfig(): Readonly<MembershipConfig> {
  if (_cached) return _cached;

  const configPath = resolve(MONOREPO_ROOT, "config/membership.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;
  _cached = Object.freeze(membershipConfigSchema.parse(parsed));
  return _cached;
}

/**
 * The six ceilings for one tier.
 * @param tier - The membership tier to look up
 * @returns That tier's limits
 * @throws {z.ZodError} if the config file is malformed (first call only)
 * @throws {Error} if `config/membership.yaml` cannot be read (first call only)
 */
export function getMembershipLimits(
  tier: ConfiguredMembershipTier,
): MembershipLimits {
  return getMembershipConfig().tiers[tier];
}

/**
 * The tier a newly registered account lands in for this deployment.
 * @returns The configured default tier
 * @throws {z.ZodError} if the config file is malformed (first call only)
 * @throws {Error} if `config/membership.yaml` cannot be read (first call only)
 */
export function getDefaultMembershipTier(): ConfiguredMembershipTier {
  return getMembershipConfig().default_tier;
}
