// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Worker YAML configuration loader.
 *
 * Reads `config/worker.yaml`: BullMQ queue parameters, the interval between
 * two questions to an upstream about a task, and the billing-query timeout.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const workerConfigSchema = z.object({
  /** Jobs one worker process runs at once: per queue, with a default for the rest. */
  concurrency: z
    .object({
      default: z.number().int().positive(),
      per_queue: z.record(z.string(), z.number().int().positive()).default({}),
    })
    .strict()
    .default({ default: 5, per_queue: {} }),
  /** BullMQ lock duration — Worker must renew within this window or the job is reclaimed. */
  lock_duration_ms: z.number().int().positive().default(600_000), // 10 min
  /** BullMQ max attempts for a job (provider retries on transport failure). */
  job_attempts: z.number().int().positive().default(3),
  /** Base backoff delay (ms) between job retries. */
  job_backoff_delay_ms: z.number().int().positive().default(2000),
  poll_interval: z.number().int().positive().default(3000),
  billing_timeout: z.number().int().positive().default(30_000),
});

/** Validated worker configuration type. */
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

let _cached: Readonly<WorkerConfig> | null = null;

/**
 * Load worker configuration from YAML.
 * @returns Frozen, validated config object
 */
export function getWorkerConfig(): Readonly<WorkerConfig> {
  if (_cached) return _cached;

  const configPath = resolve(MONOREPO_ROOT, "config/worker.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = workerConfigSchema.parse(parsed);

  _cached = Object.freeze(config);
  return _cached;
}

/**
 * How many jobs of one queue a worker process runs at once.
 * @param queue - The queue's name.
 * @returns The figure `config/worker.yaml` names for it, or its default.
 */
export function workerConcurrencyFor(queue: string): number {
  const { concurrency } = getWorkerConfig();
  return concurrency.per_queue[queue] ?? concurrency.default;
}
