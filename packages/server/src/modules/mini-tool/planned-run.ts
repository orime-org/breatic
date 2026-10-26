// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { AcceptedMiniToolExecution } from "@breatic/domain";

/**
 * Start the accepted planned run with the original row, credit-hold and queue owners.
 * @param _accepted - The complete SQL-claimed execution plan.
 * @param _userId - Its authenticated initiating actor.
 * @returns Pending after queue acceptance or failed after a refused opened run.
 * @throws {Error} Until the planned admission adapter is implemented.
 */
export async function startPlannedMiniToolRun(_accepted: AcceptedMiniToolExecution, _userId: string): Promise<"pending" | "failed"> {
  throw new Error("Planned mini-tool admission adapter is not implemented");
}
