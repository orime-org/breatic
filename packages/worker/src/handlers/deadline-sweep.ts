// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The deadline sweep (#1580): each round tells the pages what came due since the last round that finished. The
 * window is `(watermark, now]`; the watermark moves to `now` only once the round finished, so a round that fails,
 * a restart or a backlog leaves everything due in between to the next round. With no watermark the round reaches one
 * interval back.
 */

import { env, getRedis, getWorkerConfig } from "@breatic/core";
import { deadlineSweepService, readDatabaseClock } from "@breatic/domain";

/** The queue the sweep's repeatable job runs on. */
export const DEADLINE_SWEEP_QUEUE = "deadline-sweep";

/**
 * The watermark's key, with this deployment's prefix.
 * @returns The key.
 */
function watermarkKey(): string {
  return `${env.REDIS_KEY_PREFIX}:deadline-sweep:watermark`;
}

/**
 * Where the last round that finished stopped.
 * @returns The instant, or null when there is none.
 * @throws {Error} When Redis cannot be read.
 */
export async function readDeadlineWatermark(): Promise<Date | null> {
  const raw = await getRedis().get(watermarkKey());
  if (raw === null) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Record where a round stopped, or forget it.
 * @param at - The round's instant, or null to start the next round one interval back.
 * @returns Nothing.
 * @throws {Error} When Redis cannot be written.
 */
export async function writeDeadlineWatermark(at: Date | null): Promise<void> {
  if (at === null) {
    await getRedis().del(watermarkKey());
    return;
  }
  await getRedis().set(watermarkKey(), at.toISOString());
}

/**
 * Run one round, ending its window at the database's now: every read its notices cause judges by that clock.
 * @param opts - The round's instant; the database's now when absent.
 * @param opts.now - The instant to judge at.
 * @returns Nothing once the round finished and the watermark moved.
 * @throws {Error} When the round fails; the watermark stays where it was.
 */
export async function sweepDeadlines(opts: { now?: Date } = {}): Promise<void> {
  const now = opts.now ?? await readDatabaseClock();
  const from = (await readDeadlineWatermark()) ?? new Date(now.getTime() - getWorkerConfig().deadline_sweep.interval_ms);
  await deadlineSweepService.sweepDue({ from, now });
  await writeDeadlineWatermark(now);
}
