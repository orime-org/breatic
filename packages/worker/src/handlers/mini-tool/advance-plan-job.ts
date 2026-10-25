// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolPlanJobReport, MiniToolPlanJobRequest } from "@breatic/shared";

/** A terminal report retains the successful indexed subset even when computation failed. */
export type EndedMiniToolPlanJob = Extract<MiniToolPlanJobReport, { state: "done" | "failed" }>;

/**
 * Advance one already persisted media job without changing its original identity.
 * @param request - The complete request frozen together with its expense before external IO.
 * @returns The validated terminal report, including actual usage and any failed output subset.
 * @throws {Error} When the job cannot advance or its transport/contract is invalid.
 */
export async function advanceMiniToolPlanJob(request: MiniToolPlanJobRequest): Promise<EndedMiniToolPlanJob> {
  void request;
  throw new Error("Planned job advancement awaits independent RED");
}
