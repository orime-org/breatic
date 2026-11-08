// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MAX_TIMELINE_ASSET_PAGE_SIZE } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const viewport = z.object({ width: positiveInt, height: positiveInt });

/** Web-animation execution parameters (inner#1711 design §10). */
const webAnimationSchema = z.object({
  /** Longest prompt the creation dialog accepts, in characters after `extractPromptText`. */
  prompt_max_length: positiveInt.default(4000),
  /** The accepted range, and the duration the creation dialog opens at. */
  duration_seconds: z.object({ min: positiveInt.default(1), max: positiveInt.default(60), default: positiveInt.default(4) }).prefault({}),
  /** The source viewport of each aspect the dialog offers. */
  viewports: z.object({
    "16:9": viewport.default({ width: 1920, height: 1080 }),
    "9:16": viewport.default({ width: 1080, height: 1920 }),
    "1:1": viewport.default({ width: 1080, height: 1080 }),
  }).prefault({}),
  model: z.string().min(1).default("deepseek/deepseek-v4.1-flash-1017"),
  max_tokens: positiveInt.default(32_000),
  /** One model call's limit, and so the longest a cancel or deadline waits to drain it. */
  call_timeout_ms: positiveInt.default(300_000),
  max_package_bytes: positiveInt.default(5_000_000),
  font_set_version: positiveInt.default(2),
  /** How long a signed preview address stays readable. */
  preview_token_ttl_ms: positiveInt.default(3_600_000),
  /** How long the preview waits for a page's bridge-ready before it shows the copy unavailable. */
  player_load_timeout_ms: positiveInt.default(15_000),
  /** How often the worker sweeps executions that have not ended, and how many it reads per sweep. */
  sweep_interval_ms: positiveInt.default(30_000),
  sweep_batch_size: positiveInt.default(200),
  /** How long a pickup waits before asking the container job again. */
  poll_interval_ms: positiveInt.default(5_000),
  /** How often web refetches web-source resolution while it references another Project's unfinished execution. */
  source_refresh_interval_ms: positiveInt.default(10_000),
  /** The container instance the cost of a run is computed for, priced by `config/mini-tools.yaml`. */
  container: z.object({
    vcpu: z.number().positive().default(1),
    memory_gib: z.number().positive().default(6),
    disk_gb: z.number().positive().default(12),
  }).prefault({}),
}).superRefine((config, ctx) => {
  if (config.duration_seconds.min > config.duration_seconds.max) {
    ctx.addIssue({ code: "custom", path: ["duration_seconds", "min"], message: "duration_seconds.min exceeds max" });
  }
  const { min, max, default: initial } = config.duration_seconds;
  if (initial < min || initial > max) {
    ctx.addIssue({ code: "custom", path: ["duration_seconds", "default"], message: "duration_seconds.default lies outside min..max" });
  }
});

/** Runtime creation defaults and Project media parameters for Timeline. */
export const timelineConfigSchema = z.object({
  defaults: z.object({
    width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1920),
    height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1080),
    fps: z.object({
      num: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(24),
      den: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
    }).prefault({}),
  }).prefault({}),
  assets: z.object({
    page_size: z.number().int().positive().max(MAX_TIMELINE_ASSET_PAGE_SIZE).default(50),
    page_max: z.number().int().positive().max(MAX_TIMELINE_ASSET_PAGE_SIZE).default(100),
    backfill_batch_size: z.number().int().positive().default(200),
  }).prefault({}),
  web_animation: webAnimationSchema.prefault({}),
}).superRefine((config, ctx) => {
  if (config.assets.page_size > config.assets.page_max) ctx.addIssue({ code: "custom", path: ["assets", "page_size"], message: "page_size exceeds page_max" });
});

/** Validated runtime Timeline settings. */
export type TimelineConfig = z.infer<typeof timelineConfigSchema>;
let cached: Readonly<TimelineConfig> | undefined;

/**
 * Read Timeline behavior configuration lazily after service bootstrap.
 * @returns The cached validated configuration.
 * @throws {Error} When the tracked YAML cannot be read or validated.
 */
export function getTimelineConfig(): Readonly<TimelineConfig> {
  if (cached !== undefined) return cached;
  cached = Object.freeze(timelineConfigSchema.parse(parse(readFileSync(resolve(MONOREPO_ROOT, "config/timeline.yaml"), "utf8"))));
  return cached;
}
