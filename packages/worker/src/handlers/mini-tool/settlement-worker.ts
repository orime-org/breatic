// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Worker } from "bullmq";

/**
 * Register expense recovery, install its durable discovery schedule and scan on startup.
 * @returns The worker drained by the application's existing graceful shutdown.
 * @throws {Error} When registration or scheduling prevents durable recovery.
 */
export async function startMiniToolSettlementWorker(): Promise<Worker<unknown>> {
  throw new Error("Mini-tool settlement worker wiring awaits independent RED");
}
