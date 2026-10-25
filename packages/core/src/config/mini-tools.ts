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

export const miniToolsConfigSchema = z
  .object({
    poll_interval_ms: z.number().int().positive(),
    plan_limits: miniToolPlanLimitsSchema.extend({
      probeStdoutBytes: miniToolPlanLimitsSchema.shape.probeStdoutBytes.default(268_435_456),
      analysisStdoutBytes: miniToolPlanLimitsSchema.shape.analysisStdoutBytes.default(16_777_216),
      stderrTailBytes: miniToolPlanLimitsSchema.shape.stderrTailBytes.default(65_536),
    }).default({ probeStdoutBytes: 268_435_456, analysisStdoutBytes: 16_777_216, stderrTailBytes: 65_536 }),
    settlement: z.strictObject({
      lease_ms: z.number().int().positive().default(60_000),
      retry_ms: z.number().int().positive().default(30_000),
    }).default({ lease_ms: 60_000, retry_ms: 30_000 }),
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
