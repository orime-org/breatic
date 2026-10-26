// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Job } from "bullmq";
import type { MiniToolExecutionJob } from "@breatic/domain";

/**
 * Run one planned pickup through its original SQL-owned lifecycle.
 * @param _job - The queue delivery of the accepted execution.
 * @param _token - This pickup's existing queue-lock token.
 * @returns The pickup marker after persistence and permitted notifications.
 * @throws {Error} Until the planned execution wrapper is implemented.
 */
export async function runMiniToolExecutionTask(_job: Job<MiniToolExecutionJob>, _token?: string): Promise<Record<string, unknown>> {
  throw new Error("Planned execution wrapper is not implemented");
}
