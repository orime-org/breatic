// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Node task budgets loader (#186).
 *
 * Reads `config/node-tasks.yaml`: the bounds a task's conservative time is
 * held between, and what a video's cover extraction is allowed on top of the
 * transfer estimate.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const nodeTaskConfigSchema = z.object({
  upload: z.object({
    min_budget_ms: z.number().int().positive().default(900_000),
    max_budget_ms: z.number().int().positive().default(43_200_000),
    cover_reserve_ms: z.number().int().nonnegative().default(600_000),
  }),
  generation: z.object({
    budget_ms: z.number().int().positive().default(14_400_000),
  }),
});

/** Validated node task configuration. */
export type NodeTaskConfig = z.infer<typeof nodeTaskConfigSchema>;

let _cached: Readonly<NodeTaskConfig> | null = null;

/**
 * Load the node task budgets from YAML.
 * @returns Frozen, validated config, memoized after the first read.
 * @throws {z.ZodError} When a value is malformed.
 */
export function getNodeTaskConfig(): Readonly<NodeTaskConfig> {
  if (_cached) return _cached;

  const raw = readFileSync(
    resolve(MONOREPO_ROOT, "config/node-tasks.yaml"),
    "utf-8",
  );
  _cached = Object.freeze(nodeTaskConfigSchema.parse(parse(raw) as unknown));
  return _cached;
}
