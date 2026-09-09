// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Node task budget loader (#186).
 *
 * Reads `config/node-tasks.yaml`: the one deadline every task on a canvas node
 * is given, whatever kind of work it is and however large.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const nodeTaskConfigSchema = z.object({
  default_budget_ms: z.number().int().positive().default(7_200_000),
});

/** Validated node task configuration. */
export type NodeTaskConfig = z.infer<typeof nodeTaskConfigSchema>;

let _cached: Readonly<NodeTaskConfig> | null = null;

/**
 * Load the node task budget from YAML.
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
