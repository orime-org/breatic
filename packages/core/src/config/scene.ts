// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { MONOREPO_ROOT } from "@core/config/env.js";

/** Runtime parameters for the versioned 3D scene controls adapter, the model import budgets, the viewfinder capture and the director console. */
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
    progress_publish_ms: z.number().int().positive().default(1000),
  }).prefault({}),
  capture: z.object({
    long_edge_px: z.number().int().positive().default(2048),
    min_frame_px: z.number().int().positive().default(120),
    canvas_sync_timeout_ms: z.number().int().positive().default(10000),
  }).prefault({}),
  director: z.object({
    monitor_refresh_ms: z.number().int().positive().default(200),
    max_lights: z.number().int().positive().default(16),
    wheel_commit_ms: z.number().int().positive().default(400),
    shadow_map_px: z.number().int().positive().default(2048),
    point_shadow_map_px: z.number().int().positive().default(512),
    shadow_ground_reach: z.number().finite().positive().default(3),
    shadow_bias: z.number().finite().default(-0.0005),
    shadow_normal_bias: z.number().finite().default(0.02),
    point_shadow_bias: z.number().finite().default(-0.002),
    point_shadow_normal_bias: z.number().finite().default(0.02),
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
