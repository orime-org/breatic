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
import { CONTAINER_OPS, type ContainerOp } from "@breatic/shared";
import { MONOREPO_ROOT } from "@core/config/env.js";

const classSchema = z.object({
  instance_type: z.string().min(1),
  vcpu: z.number().positive(),
  memory_gib: z.number().positive(),
  disk_gb: z.number().positive(),
});

const opSchema = z.object({
  container_class: z.string().min(1),
  job_deadline_ms: z.number().int().positive(),
  precheck_seconds: z.number().positive(),
});

const miniToolsConfigSchema = z
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
