// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Container mini-tool loader (inner#888 §8, §9).
 *
 * Reads `config/mini-tools.yaml`: which container class each operation runs
 * in, how long it may run, what the precheck holds the reader to, and the
 * published prices a run's seconds are charged at.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CONTAINER_OPS, type ContainerOp } from "@breatic/shared/mini-tools";
import { miniToolPlanLimitsSchema } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

const classSchema = z.object({
  instance_type: z.string().min(1),
  vcpu: z.number().positive(),
  memory_gib: z.number().positive(),
  disk_gb: z.number().positive(),
});

const opSchema = z.strictObject({
  container_class: z.string().min(1),
  precheck_seconds: z.number().positive(),
});

const analysisProfileSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  weightsHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  params: z.record(z.string(), z.json()),
});

const analysisConfigSchema = z.strictObject({
  profile: analysisProfileSchema,
  container_class: z.string().min(1),
  precheck_seconds: z.number().positive(),
});

const sourceLedgerDefaults = {
  max_bytes: 16_777_216,
  probe_stdout_bytes: 67_108_864,
  metadata_bytes: 16_777_216,
  iso_box_count: 100_000,
  matroska_element_count: 1_000_000,
  matroska_max_blocks: 250_000,
};
const sourceLedgerConfigSchema = z.strictObject({
  max_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.max_bytes),
  probe_stdout_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.probe_stdout_bytes),
  metadata_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.metadata_bytes),
  iso_box_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.iso_box_count),
  matroska_element_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.matroska_element_count),
  matroska_max_blocks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(sourceLedgerDefaults.matroska_max_blocks),
});

export const miniToolsConfigSchema = z
  .object({
    poll_interval_ms: z.number().int().positive(),
    executions: z.strictObject({
      "video.remove-bg": z.strictObject({ model: z.string().min(1) }),
    }).default({ "video.remove-bg": { model: "bria-fibo-video-background-remover" } }),
    presentation: z.strictObject({
      container_class: z.string().min(1).default("MediaContainer"),
      // Every uploadable video gets a presentation and a ledger: this equals storage.upload.max_upload_bytes.
      max_source_bytes: z.number().int().positive().default(2_147_483_648),
      max_packed_bytes: z.number().int().positive().default(1_073_741_824),
      crf: z.number().int().min(0).max(51).default(18),
      preset: z.enum(["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"]).default("medium"),
      source_ledger: sourceLedgerConfigSchema.default(sourceLedgerDefaults),
    }).default({ container_class: "MediaContainer", max_source_bytes: 2_147_483_648, max_packed_bytes: 1_073_741_824, crf: 18, preset: "medium", source_ledger: sourceLedgerDefaults }),
    plan_limits: miniToolPlanLimitsSchema.extend({
      probeStdoutBytes: miniToolPlanLimitsSchema.shape.probeStdoutBytes.default(268_435_456),
      analysisStdoutBytes: miniToolPlanLimitsSchema.shape.analysisStdoutBytes.default(16_777_216),
      stderrTailBytes: miniToolPlanLimitsSchema.shape.stderrTailBytes.default(65_536),
    }).default({ probeStdoutBytes: 268_435_456, analysisStdoutBytes: 16_777_216, stderrTailBytes: 65_536 }),
    delivery: z.strictObject({
      discovery_interval_ms: z.number().int().positive().default(30_000),
      discovery_page_size: z.number().int().positive().default(100),
    }).default({ discovery_interval_ms: 30_000, discovery_page_size: 100 }),
    settlement: z.strictObject({
      lease_ms: z.number().int().positive().default(60_000),
      retry_ms: z.number().int().positive().default(30_000),
      lookup_timeout_ms: z.number().int().positive().default(15_000),
      discovery_interval_ms: z.number().int().positive().default(30_000),
      discovery_page_size: z.number().int().positive().default(100),
    }).default({ lease_ms: 60_000, retry_ms: 30_000, lookup_timeout_ms: 15_000, discovery_interval_ms: 30_000, discovery_page_size: 100 }),
    prices: z.object({
      vcpu_second_usd: z.number().nonnegative(),
      memory_gib_second_usd: z.number().nonnegative(),
      disk_gb_second_usd: z.number().nonnegative(),
    }),
    classes: z.record(z.string(), classSchema),
    ops: z.strictObject(
      Object.fromEntries(CONTAINER_OPS.map((op) => [op, opSchema])) as Record<ContainerOp, typeof opSchema>,
    ),
    analyses: z.strictObject({
      people: analysisConfigSchema,
      scene_cuts: analysisConfigSchema,
      tracked_mask: analysisConfigSchema,
    }),
    // The audio cut band draws from the peaks file beside the source; while that
    // file is missing it decodes the source in the browser only under both of
    // these: the length bounds what the tab holds, the size what it downloads.
    waveform_max_seconds: z.number().positive().default(600),
    waveform_max_bytes: z.number().int().positive().default(200_000_000),
    // How often, and for how long, a band past those reads peaks not yet written.
    waveform_peaks_retry_ms: z.number().int().positive().default(5000),
    waveform_peaks_retry_max_ms: z.number().int().positive().default(600_000),
  })
  .superRefine((config, ctx) => {
    if (!(config.presentation.container_class in config.classes)) {
      ctx.addIssue({ code: "custom", path: ["presentation", "container_class"], message: "Presentation names an undeclared container class" });
    }
    for (const [op, spec] of Object.entries(config.ops)) {
      if (!(spec.container_class in config.classes)) {
        ctx.addIssue({
          code: "custom",
          path: ["ops", op, "container_class"],
          message: `names "${spec.container_class}", which classes does not declare`,
        });
      }
    }
    for (const [kind, spec] of Object.entries(config.analyses)) {
      if (!(spec.container_class in config.classes)) {
        ctx.addIssue({ code: "custom", path: ["analyses", kind, "container_class"], message: "Analysis names an undeclared container class" });
      }
    }
  });

/** Validated container mini-tool configuration. */
export type MiniToolsConfig = z.infer<typeof miniToolsConfigSchema>;

let _cached: Readonly<MiniToolsConfig> | null = null;

/**
 * Load the container mini-tool configuration from YAML.
 * @returns Frozen, validated config, memoized after the first read.
 * @throws {z.ZodError} When a value is malformed or an op names an undeclared class.
 */
export function getMiniToolsConfig(): Readonly<MiniToolsConfig> {
  if (_cached) return _cached;

  const raw = readFileSync(resolve(MONOREPO_ROOT, "config/mini-tools.yaml"), "utf-8");
  _cached = Object.freeze(miniToolsConfigSchema.parse(parse(raw) as unknown));
  return _cached;
}
