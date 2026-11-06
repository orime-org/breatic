// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { MONOREPO_ROOT } from "@core/config/env.js";

/** Runtime parameters for the versioned 3D scene controls adapter and the model import budgets. */
export const sceneConfigSchema = z.object({
  scale_sensitivity: z.number().finite().positive().default(0.01),
  import: z.object({
    max_input_bytes: z.number().int().positive().default(67108864),
    max_expanded_bytes: z.number().int().positive().default(268435456),
    max_artifact_bytes: z.number().int().positive().default(268435456),
    max_files: z.number().int().positive().default(4096),
    max_entry_json_bytes: z.number().int().positive().default(4194304),
    decoder_worker_limit: z.number().int().positive().default(1),
    max_texture_edge: z.number().int().positive().default(8192),
    max_texture_bytes: z.number().int().positive().default(268435456),
  }).prefault({}),
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
