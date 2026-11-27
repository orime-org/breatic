// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { Worker } from "bullmq";
import {
  createQueue, createWorker, getMiniToolsConfig, logger,
  MINI_TOOL_SETTLEMENT_QUEUE, MINI_TOOL_SETTLEMENT_JOB, MINI_TOOL_SETTLEMENT_DISCOVERY_JOB,
  miniToolSettlementWakeSchema, miniToolSettlementDiscoverySchema,
} from "@breatic/core";
import { listDueMiniToolSettlements, runMiniToolSettlement, type DueMiniToolSettlement } from "@breatic/domain";
import { untilDeadline } from "@breatic/shared";
import { lookupMiniToolConsumption } from "@worker/handlers/mini-tool/lookup-consumption.js";

/**
 * Register expense recovery, install its durable discovery schedule and scan on startup.
 * @returns The worker drained by the application's existing graceful shutdown.
 * @throws {Error} When registration or scheduling prevents durable recovery.
 */
export async function startMiniToolSettlementWorker(): Promise<Worker<unknown>> {
  const config = getMiniToolsConfig().settlement;
  const queue = createQueue(MINI_TOOL_SETTLEMENT_QUEUE);
  const retention = { removeOnComplete: true, removeOnFail: true };

  /**
   * Deliver only the current SQL identity; an early or repeated wake is still arbitrated by SQL.
   * @param current - The committed waiting period, retaining its original precise due time.
   * @returns Nothing after the delivery is accepted.
   * @throws {Error} When validation or Redis delivery fails; periodic discovery can recover it.
   */
  const enqueue = async (current: DueMiniToolSettlement): Promise<void> => {
    const wake = miniToolSettlementWakeSchema.parse({ taskId: current.taskId, settlementVersion: current.settlementVersion });
    await queue.add(MINI_TOOL_SETTLEMENT_JOB, wake, {
      ...retention, jobId: `mini-tool-${wake.taskId}-${wake.settlementVersion}`, delay: Math.max(0, Date.parse(current.dueAt) - Date.now()),
    });
  };

  const worker = createWorker<unknown>(MINI_TOOL_SETTLEMENT_QUEUE, async (job) => {
    try {
      if (job.name === MINI_TOOL_SETTLEMENT_DISCOVERY_JOB) {
        const request = miniToolSettlementDiscoverySchema.parse(job.data);
        const page = await listDueMiniToolSettlements({ limit: config.discovery_page_size, ...request });
        await Promise.all(page.items.map(enqueue));
        if (page.nextCursor !== null) await queue.add(MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, { cursor: page.nextCursor }, retention);
        return;
      }
      if (job.name !== MINI_TOOL_SETTLEMENT_JOB) throw new Error("Unknown mini-tool settlement job");
      const wake = miniToolSettlementWakeSchema.parse(job.data);
      const result = await runMiniToolSettlement(wake, (input) => lookupMiniToolConsumption(input, untilDeadline(Date.now() + config.lookup_timeout_ms)));
      if ("failure" in result) logger.error({ err: result.failure, ctx: wake }, "mini_tool_settlement_deferred");
      // The recorded request stays pending; the credit-charge sweep settles it later.
      if (result.charge?.state === "settled" && "chargeFailure" in result.charge) {
        logger.error({ err: result.charge.chargeFailure, ctx: wake }, "mini_tool_settlement_charge_pending");
      }
      if (result.nextWake !== null) await enqueue(result.nextWake);
    } catch (err) {
      logger.error({ err, ctx: { jobId: job.id, name: job.name, data: job.data } }, "mini_tool_settlement_job_failed");
      throw err;
    }
  });
  worker.on("failed", (job, err) => {
    logger.error({ err, ctx: { jobId: job?.id, name: job?.name, data: job?.data } }, "mini_tool_settlement_delivery_failed");
  });
  try {
    await queue.upsertJobScheduler(MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, { every: config.discovery_interval_ms }, {
      name: MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, data: {}, opts: retention,
    });
    await queue.add(MINI_TOOL_SETTLEMENT_DISCOVERY_JOB, {}, retention);
    return worker;
  } catch (err) {
    logger.error({ err, ctx: { queue: MINI_TOOL_SETTLEMENT_QUEUE } }, "mini_tool_settlement_start_failed");
    await worker.close();
    throw err;
  }
}
