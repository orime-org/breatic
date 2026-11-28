// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { MONOREPO_ROOT } from "@core/config/runtime.js";

/** Runtime parameters of influencer sites (inner#2157). */
export const influencersConfigSchema = z.object({
  /** How long the registered hosts are cached in-process, in seconds. */
  trusted_hosts_cache_seconds: z.number().int().positive().default(60),
});

/** Validated influencer configuration. */
export type InfluencersConfig = z.infer<typeof influencersConfigSchema>;

let cached: Readonly<InfluencersConfig> | null = null;

/**
 * Load the influencer configuration on first use.
 * @returns Frozen, validated configuration from config/influencers.yaml.
 * @throws {Error} When the YAML file cannot be read or parsed.
 * @throws {z.ZodError} When a configuration value is invalid.
 */
export function getInfluencersConfig(): Readonly<InfluencersConfig> {
  if (cached) return cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/influencers.yaml"), "utf-8");
  cached = Object.freeze(influencersConfigSchema.parse((parse(raw) as unknown) ?? {}));
  return cached;
}
