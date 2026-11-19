// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker YAML configuration loader.
 *
 * Reads `config/worker.yaml`: BullMQ queue parameters, the interval between
 * two questions to an upstream about a task.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

export const workerConfigSchema = z.object({
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
  /** A waiting task not judged by the running-task gate for this long no longer holds its place in line (inner#1968). */
  slot_wait_stale_ms: z.number().int().positive().default(120_000),
  /** The longest a task waiting for a running-task slot is put off before it is judged again. */
  slot_wait_max_delay_ms: z.number().int().positive().default(30_000),
  /** How often the sweep runs that ends as failed the stale slot waiters whose job will not pick them up again. */
  slot_wait_sweep_interval_ms: z.number().int().positive().default(60_000),
  /** How many stale waiters one round of that sweep looks at. */
  slot_wait_sweep_batch_size: z.number().int().positive().default(200),
  /** How long a pickup tries for the person's running-task gate lock before going back to the queue. */
  slot_lock_wait_ms: z.number().int().nonnegative().default(200),
  /** The sweep that settles charge requests still pending (inner#1617). */
  credit_charge_sweep: z
    .object({
      interval_ms: z.number().int().positive().default(60_000),
      min_age_ms: z.number().int().nonnegative().default(30_000),
      batch_size: z.number().int().positive().default(100),
    })
    .strict()
    .prefault({}),
}).refine(
  // A waiter is judged at most every slot_wait_max_delay_ms and its check time
  // is rewritten only once older than a third of slot_wait_stale_ms; past this
  // a waiter still in line reads as stale and later tasks start ahead of it.
  (config) => config.slot_wait_max_delay_ms + config.slot_wait_stale_ms / 3 < config.slot_wait_stale_ms,
  { message: "slot_wait_max_delay_ms plus a third of slot_wait_stale_ms must stay below slot_wait_stale_ms", path: ["slot_wait_max_delay_ms"] },
);

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
 * Refuse per-queue figures for queues this process does not run: a
 * misspelt name would leave the queue it meant at the default.
 * @param queues - The queues the worker process runs.
 * @throws {Error} When `concurrency.per_queue` names any other queue.
 */
export function assertKnownQueues(queues: readonly string[]): void {
  const unknown = Object.keys(getWorkerConfig().concurrency.per_queue).filter((name) => !queues.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `config/worker.yaml concurrency.per_queue names ${unknown.join(", ")}, which this worker does not run (it runs ${queues.join(", ")})`,
    );
  }
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
