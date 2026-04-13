/**
 * Worker YAML configuration loader.
 *
 * Reads `config/worker.yaml` for BullMQ and HTTP retry parameters.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const workerConfigSchema = z.object({
  concurrency: z.number().int().positive().default(5),
  /** BullMQ lock duration — Worker must renew within this window or the job is reclaimed. */
  lock_duration_ms: z.number().int().positive().default(600_000), // 10 min
  /** BullMQ max attempts for a job (provider retries on transport failure). */
  job_attempts: z.number().int().positive().default(3),
  /** Base backoff delay (ms) between job retries. */
  job_backoff_delay_ms: z.number().int().positive().default(2000),
  http_max_retries: z.number().int().min(0).default(3),
  http_retry_base_delay: z.number().int().positive().default(2000),
  poll_interval: z.number().int().positive().default(3000),
  poll_max_wait: z.number().int().positive().default(300_000),
  billing_timeout: z.number().int().positive().default(30_000),
});

/** Validated worker configuration type. */
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

let _cached: Readonly<WorkerConfig> | null = null;

/**
 * Load worker configuration from YAML.
 *
 * @returns Frozen, validated config object
 */
export function getWorkerConfig(): Readonly<WorkerConfig> {
  if (_cached) return _cached;

  const configPath = resolve(import.meta.dirname, "../../../../config/worker.yaml");
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw) as unknown;
  const config = workerConfigSchema.parse(parsed);

  _cached = Object.freeze(config);
  return _cached;
}
