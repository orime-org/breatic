// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Job, Worker } from "bullmq";
import type { MiniToolDeliveryWake } from "@breatic/core";

/**
 * Enqueue only a durable SQL delivery identity on the existing tasks queue.
 * @param _wake - The original task and current delivery version.
 * @returns Nothing after enqueue acceptance.
 * @throws {Error} Until the delivery adapter is implemented.
 */
export async function enqueueMiniToolDelivery(_wake: MiniToolDeliveryWake): Promise<void> {
  throw new Error("Mini-tool delivery queue adapter is not implemented");
}

/**
 * Dispatch a strict delivery or discovery job without entering computation.
 * @param _job - The original named queue envelope.
 * @returns The processor's internal completion marker.
 * @throws {Error} Until the delivery processor is implemented.
 */
export async function runMiniToolDeliveryJob(_job: Job<unknown>): Promise<Record<string, unknown>> {
  throw new Error("Mini-tool delivery processor is not implemented");
}

/**
 * Install recovery on the existing tasks worker without creating another worker.
 * @param _tasksWorker - This instance's already-owned tasks worker.
 * @returns Nothing after scheduler and startup discovery acceptance.
 * @throws {Error} Until the delivery startup adapter is implemented.
 */
export async function startMiniToolDeliveryRecovery(_tasksWorker: Pick<Worker, "close">): Promise<void> {
  throw new Error("Mini-tool delivery startup adapter is not implemented");
}
