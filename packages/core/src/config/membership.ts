// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Membership quota configuration loader.
 *
 * Reads `config/membership.yaml`: which tier a new account lands in, and the
 * six ceilings each of the four tiers carries.
 *
 * Lives in core rather than beside the other business limits in server,
 * because three services need it: server enforces four of the ceilings,
 * collab enforces the concurrency one, and worker enforces the storage one
 * on the generation path. Neither collab nor worker may import server.
 *
 * Unlike the sibling loaders in this directory, **no field has a default**.
 * A quota that silently falls back to a number we invented is worse than a
 * service that refuses to start: the operator would go on believing the
 * value they wrote in the file is the one being enforced. Startup calls
 * {@link getMembershipConfig} once so a malformed file fails the boot rather
 * than the first user who happens to hit a ceiling.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MEMBERSHIP_TIERS, type MembershipLimits, type MembershipTier } from "@breatic/shared";
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

/** The six ceilings every tier carries. */
const tierLimitsSchema = z.object({
  team_studios: limitSchema,
  projects_per_studio: limitSchema,
  concurrent_editors: limitSchema,
  studio_members: limitSchema,
  project_members: limitSchema,
  storage_bytes: limitSchema,
});

/** Schema for `config/membership.yaml`. */
export const membershipConfigSchema = z.object({
  /**
   * Which tier a newly registered account lands in.
   *
   * This one field is what makes a deployment ours or somebody else's: we
   * ship `base` and let people pay their way up; a self-hosted install ships
   * `enterprise` and fills that tier's numbers itself. No separate
   * "self-hosted mode" switch exists, because this field already says it.
   */
  default_tier: z.enum(MEMBERSHIP_TIERS),
  tiers: z.object({
    base: tierLimitsSchema,
    pro: tierLimitsSchema,
    team: tierLimitsSchema,
    enterprise: tierLimitsSchema,
  }),
});

/** Validated membership configuration. */
export type MembershipConfig = z.infer<typeof membershipConfigSchema>;

let _cached: Readonly<MembershipConfig> | null = null;

/**
 * Load the membership configuration from YAML.
 *
 * Memoized. Call it once from each service's composition root so a malformed
 * file is a boot failure.
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
export function getMembershipLimits(tier: MembershipTier): MembershipLimits {
  return getMembershipConfig().tiers[tier];
}

/**
 * The tier a newly registered account lands in for this deployment.
 * @returns The configured default tier
 * @throws {z.ZodError} if the config file is malformed (first call only)
 * @throws {Error} if `config/membership.yaml` cannot be read (first call only)
 */
export function getDefaultMembershipTier(): MembershipTier {
  return getMembershipConfig().default_tier;
}
