// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Container mini-tool loader (inner#888 §8, §9).
 *
 * Reads `config/mini-tools.yaml`: which container class each operation runs
 * in, how long it may run, what the precheck holds the user to, and the
 * published prices a run's seconds are charged at.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MINI_TOOL_JOB_MAX_EXTRA_INPUTS } from "@breatic/shared";
import { CONTAINER_OPS, type ContainerOp } from "@breatic/shared/mini-tools";
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

export const miniToolsConfigSchema = z
  .object({
    poll_interval_ms: z.number().int().positive(),
    prices: z.object({
      vcpu_second_usd: z.number().nonnegative(),
      memory_gib_second_usd: z.number().nonnegative(),
      disk_gb_second_usd: z.number().nonnegative(),
    }),
    classes: z.record(z.string(), classSchema),
    ops: z.strictObject(
      Object.fromEntries(CONTAINER_OPS.map((op) => [op, opSchema])) as Record<ContainerOp, typeof opSchema>,
    ),
    // The audio cut band draws from the peaks file beside the source; while that
    // file is missing it decodes the source in the browser only under both of
    // these: the length bounds what the tab holds, the size what it downloads.
    waveform_max_seconds: z.number().positive().default(600),
    waveform_max_bytes: z.number().int().positive().default(200_000_000),
    // The most clips one join takes, source included (inner#1825 §6.3); the
    // job contract carries the source plus MINI_TOOL_JOB_MAX_EXTRA_INPUTS.
    join_max_clips: z
      .number()
      .int()
      .min(2)
      .max(MINI_TOOL_JOB_MAX_EXTRA_INPUTS + 1)
      .default(20),
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

/**
 * How long past a task's deadline its last report may still land: two poll
 * intervals. The worker waits this long before settling a container job as
 * expired, and the running-task count uses the same room (inner#1968), so
 * both agree on when a task is over.
 * @param pollIntervalMs - The poll interval; the configured one by default.
 * @returns The grace in milliseconds.
 * @throws {z.ZodError} if the config file is malformed (first read only)
 * @throws {Error} if `config/mini-tools.yaml` cannot be read (first read only)
 */
export function reportGraceMs(pollIntervalMs: number = getMiniToolsConfig().poll_interval_ms): number {
  return pollIntervalMs * 2;
}
