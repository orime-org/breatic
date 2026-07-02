// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * BullMQ queue and worker factories.
 *
 * BullMQ requires its own dedicated ioredis connection (separate from
 * the application Redis client). This module manages that connection.
 */

import { Queue, QueueEvents, Worker } from "bullmq";
import type { Processor, ConnectionOptions } from "bullmq";
import { env } from "@core/config/env.js";
import { getWorkerConfig } from "@core/config/worker.js";

/**
 * Parse REDIS_QUEUE_URL into BullMQ-compatible connection options.
 *
 * BullMQ accepts a plain connection config object, avoiding ioredis
 * version mismatch issues.
 * @returns BullMQ connection options derived from `REDIS_QUEUE_URL`
 */
function parseRedisUrl(): ConnectionOptions {
  const url = new URL(env.REDIS_QUEUE_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    db: Number(url.pathname.slice(1)) || 0,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

const _queues: Queue[] = [];
const _workers: Worker[] = [];
const _queueEvents: QueueEvents[] = [];

/**
 * Create a BullMQ queue.
 * @param name - Queue name
 * @returns A new BullMQ Queue instance
 */
export function createQueue(name: string): Queue {
  const queue = new Queue(name, { connection: parseRedisUrl() });
  _queues.push(queue);
  return queue;
}

/**
 * Create a BullMQ QueueEvents listener.
 *
 * Unlike a `Worker` callback (process-local, dies with its process), a
 * `QueueEvents` instance receives queue lifecycle events (completed /
 * failed / stalled) cross-process — every subscribed instance is notified.
 * Used by the worker's failed-job write-back net so a job whose own worker
 * crashed is still cleaned up by another live instance (#1580 #6).
 * @param name - Queue name to observe.
 * @returns A new BullMQ QueueEvents instance.
 */
export function createQueueEvents(name: string): QueueEvents {
  const queueEvents = new QueueEvents(name, { connection: parseRedisUrl() });
  _queueEvents.push(queueEvents);
  return queueEvents;
}

/**
 * Create a BullMQ worker.
 *
 * - `concurrency` / `lockDuration` come from `config/worker.yaml`.
 * - `lockDuration` is set generously (default 10 min) to cover slow
 *   single-step operations like large video uploads or 3D generation.
 *   If a Worker ever exceeds this without renewing the lock, BullMQ
 *   will consider the job "stalled" and hand it to another Worker —
 *   in which case the re-entry guard in `runTask` (checks
 *   `tasks.provider_result_url`) prevents a duplicate provider call.
 * @param name - Queue name to consume from
 * @param processor - Job processor function
 * @returns A new BullMQ Worker instance
 */
export function createWorker<T>(
  name: string,
  processor: Processor<T>,
): Worker<T> {
  const cfg = getWorkerConfig();
  const worker = new Worker<T>(name, processor, {
    connection: parseRedisUrl(),
    concurrency: cfg.concurrency,
    lockDuration: cfg.lock_duration_ms,
  });
  _workers.push(worker);
  return worker;
}

/**
 * Default BullMQ job options applied to every task we enqueue.
 *
 * - `attempts` controls how many times BullMQ will re-invoke the
 *   handler when it throws. Provider HTTP failures (network blip,
 *   429) benefit from retries. The Worker's re-entry guard makes
 *   sure the provider is never called twice per task, so retries
 *   only kick in for the pre-provider stage.
 * - `backoff` uses exponential delay (base * 2^attempt) so the
 *   second retry waits longer than the first.
 * - `removeOnComplete` / `removeOnFail` keep the Redis queue clean.
 * @returns the default BullMQ job options (attempts, backoff, retention)
 */
export function defaultJobOpts(): {
  attempts: number;
  backoff: { type: "exponential"; delay: number };
  removeOnComplete: { age: number; count: number };
  removeOnFail: { age: number; count: number };
} {
  const cfg = getWorkerConfig();
  return {
    attempts: cfg.job_attempts,
    backoff: { type: "exponential", delay: cfg.job_backoff_delay_ms },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400, count: 1000 },
  };
}

/**
 * Close all BullMQ queues and workers.
 *
 * Call during graceful shutdown.
 */
export async function closeQueues(): Promise<void> {
  await Promise.allSettled([
    ..._queues.map((q) => q.close()),
    ..._workers.map((w) => w.close()),
    ..._queueEvents.map((qe) => qe.close()),
  ]);
  _queues.length = 0;
  _workers.length = 0;
  _queueEvents.length = 0;
}
