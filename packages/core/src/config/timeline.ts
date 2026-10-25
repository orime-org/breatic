// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MAX_TIMER_MS, MAX_TIMELINE_ASSET_PAGE_SIZE } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

/** Runtime defaults and bounded client transport parameters for Timeline. */
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
  persistence: z.object({
    batch_size: z.number().int().min(1).max(128).default(64),
    poll_interval_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(1500),
    rpc_timeout_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(10000),
    retry_min_interval_ms: z.number().int().min(1).max(MAX_TIMER_MS).default(1000),
  }).prefault({}),
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
