// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Job } from "bullmq";
import type { miniToolAnalysisService, MiniToolAnalysisJob } from "@breatic/domain";
import type { MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

/** The original analysis computation is selected after loading its SQL identity. */
export type MiniToolAnalysisExecutor = (execution: miniToolAnalysisService.MiniToolAnalysisExecution, deadlineAt: number) => Promise<MiniToolAnalysisResult>;

/**
 * Execute one analysis pickup through the existing task lifecycle and completion owner.
 * @param _job - The queue delivery of the original accepted analysis.
 * @param _token - This pickup's existing BullMQ ownership token.
 * @param _execute - The kind-specific executor consuming SQL-owned inputs.
 * @returns The current computation outcome or lost-ownership marker.
 * @throws {Error} When waiting, retry or infrastructure recovery belongs to the queue.
 */
export async function runMiniToolAnalysisTask(
  _job: Job<MiniToolAnalysisJob>, _token: string | undefined, _execute: MiniToolAnalysisExecutor,
): Promise<Record<string, unknown>> {
  throw new Error("Analysis task lifecycle is not implemented");
}
