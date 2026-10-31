// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { MONOREPO_ROOT } from "@core/config/env.js";

/** Runtime parameters for the versioned 3D scene controls adapter. */
export const sceneConfigSchema = z.object({
  scale_sensitivity: z.number().finite().positive().default(0.01),
});

/** Validated scene runtime configuration. */
export type SceneConfig = z.infer<typeof sceneConfigSchema>;

let cached: Readonly<SceneConfig> | null = null;

/**
 * Load the scene controls configuration on first use.
 * @returns Frozen, validated configuration from config/scene.yaml.
 * @throws {Error} When the YAML file cannot be read or parsed.
 * @throws {z.ZodError} When a configuration value is invalid.
 */
export function getSceneConfig(): Readonly<SceneConfig> {
  if (cached) return cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/scene.yaml"), "utf-8");
  cached = Object.freeze(sceneConfigSchema.parse(parse(raw) as unknown));
  return cached;
}
