// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The loops that finish work left between the global region and another
 * region (inner#1955):
 *
 * - every region finishes Studio transfers left in the accepting window,
 *   between the global admin change and the role swap here;
 * - the global region finishes or gives up Studio creations left pending in
 *   another region.
 *
 * Every server instance runs them. Each step answers a repeat as it did the
 * first time and re-checks its row under its lock, so two instances finishing
 * the same work do it once.
 */

import { env, getRegionsConfig, logger, isGlobalRegion, otherRegionsOf } from "@breatic/core";
import { regionClient, studioCreationService } from "@breatic/domain";
import { getTrialGrantCredits } from "@server/config/pricing.js";
import { sweepAcceptingTransfers } from "@server/modules/studio/studioTransfer.service.js";

/** The running loops. */
export interface RegionLoops {
  stop(): Promise<void>;
}

/** One loop: what it runs and how often. */
interface Loop {
  name: string;
  intervalMs: number;
  run: () => Promise<number>;
}

/**
 * Start the region loops this process runs.
 * @returns The loops, to stop on shutdown.
 */
export function startRegionLoops(): RegionLoops {
  const config = getRegionsConfig();
  const loops: Loop[] = [
    {
      name: "studio_transfer_accepting_sweep",
      intervalMs: config.transfer_accepting_sweep_interval_ms,
      run: () => sweepAcceptingTransfers({ olderThanMs: config.transfer_accepting_stale_ms }),
    },
  ];
  if (isGlobalRegion(env) && otherRegionsOf(env).length > 0) {
    loops.push({
      name: "studio_creation_sweep",
      intervalMs: config.studio_creation_sweep_interval_ms,
      run: async () => {
        const swept = await studioCreationService.sweepPendingStudios({
          olderThanMs: config.studio_creation_stale_ms,
          regionClient,
          trialCredits: env.PAYMENT_ENABLED ? getTrialGrantCredits() : 0,
        });
        for (const { studioId, region, err } of swept.unreachable) {
          logger.warn({ err, studioId, region }, "studio_creation_sweep_region_unreachable");
        }
        return swept.finished + swept.abandoned;
      },
    });
  }

  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const running = new Set<Promise<void>>();

  /**
   * Run one loop once, then schedule its next run once this one has settled.
   * @param loop - The loop.
   */
  const tick = (loop: Loop): void => {
    if (stopped) return;
    const run = loop
      .run()
      .then((done) => {
        if (done > 0) logger.info({ done }, loop.name);
      })
      .catch((err: unknown) => logger.error({ err }, `${loop.name}_failed`))
      .finally(() => {
        running.delete(run);
        schedule(loop);
      });
    running.add(run);
  };

  /**
   * Schedule a loop's next run.
   * @param loop - The loop.
   */
  const schedule = (loop: Loop): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      tick(loop);
    }, loop.intervalMs);
    timers.add(timer);
  };

  for (const loop of loops) schedule(loop);

  return {
    async stop(): Promise<void> {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      await Promise.all(running);
    },
  };
}
