// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Database configuration loader (#1435, #1047).
 *
 * Reads `config/database.yaml`: how long a query may wait for a pooled
 * connection and how long opening a connection may take. `createPgClient`
 * applies both to every pool it builds.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const seconds = z.number().int().positive();

/**
 * The shape `config/database.yaml` is parsed against.
 *
 * Exported for tests only; application code reads {@link getDatabaseTimeouts}.
 */
export const databaseConfigSchema = z.object({
  pool: z
    .object({
      connect_timeout_s: seconds.default(30),
      queue_timeout_s: seconds.default(30),
    })
    .prefault({}),
});

type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

/** The pool wait limits, in seconds. */
export interface DatabaseTimeouts {
  readonly connectTimeoutS: number;
  readonly queueTimeoutS: number;
}

let cached: DatabaseConfig | null = null;

/**
 * Reads and validates `config/database.yaml` once.
 * @returns The parsed configuration.
 * @throws {Error} When the file is missing or malformed.
 */
function loadDatabaseConfig(): DatabaseConfig {
  if (cached) return cached;
  const configPath = resolve(MONOREPO_ROOT, "config/database.yaml");
  cached = databaseConfigSchema.parse(parse(readFileSync(configPath, "utf-8")));
  return cached;
}

/**
 * Reads the pool wait limits from `config/database.yaml`.
 * @returns The two limits, in seconds.
 * @throws {Error} When the file is missing or malformed.
 */
export function getDatabaseTimeouts(): DatabaseTimeouts {
  const { pool } = loadDatabaseConfig();
  return { connectTimeoutS: pool.connect_timeout_s, queueTimeoutS: pool.queue_timeout_s };
}
