// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { STUDIO_PAGE_POLL_DEFAULT_MS } from "@breatic/shared";

import { MONOREPO_ROOT } from "@core/config/env.js";

/** Runtime parameters of the Studio page's one poll (#1580). */
export const studioPageConfigSchema = z.object({
  /** How long after each answer the page asks again, in ms. */
  poll_interval_ms: z.number().int().positive().default(STUDIO_PAGE_POLL_DEFAULT_MS),
});

/** Validated Studio page configuration. */
export type StudioPageConfig = z.infer<typeof studioPageConfigSchema>;

let cached: Readonly<StudioPageConfig> | null = null;

/**
 * Load the Studio page configuration on first use.
 * @returns Frozen, validated configuration from config/studio-page.yaml.
 * @throws {Error} When the YAML file cannot be read or parsed.
 * @throws {z.ZodError} When a configuration value is invalid.
 */
export function getStudioPageConfig(): Readonly<StudioPageConfig> {
  if (cached) return cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/studio-page.yaml"), "utf-8");
  cached = Object.freeze(studioPageConfigSchema.parse((parse(raw) as unknown) ?? {}));
  return cached;
}
