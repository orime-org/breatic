// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

/** The versioned per-output media recipes admitted by the planned job lane. */
export const miniToolPlanRecipeSchema = z.never();

/** The request holding a complete chunk's input and output identities. */
export const miniToolPlanJobRequestSchema = z.never();

/** The indexed report of a planned job's actual written objects. */
export const miniToolPlanJobReportSchema = z.never();

/** A job's exact read and write capabilities. */
export interface MiniToolPlanAccess {
  reads: string[];
  writes: Record<string, string>;
}

/**
 * Resolve the frozen inputs and outputs into the container's capabilities.
 * @param request - The planned job request.
 * @throws {Error} Until the versioned capabilities are implemented.
 */
export function miniToolPlanAccess(request: unknown): MiniToolPlanAccess {
  void request;
  throw new Error("Planned job capabilities are not implemented");
}

/**
 * Compare a repeated submission with the job's original frozen request.
 * @param accepted - The originally accepted request.
 * @param incoming - The repeated submission.
 * @throws {Error} Until planned request replay is implemented.
 */
export function sameMiniToolPlanJob(accepted: unknown, incoming: unknown): boolean {
  void accepted; void incoming;
  throw new Error("Planned job replay is not implemented");
}

/**
 * Validate an indexed report against the job's original output identities.
 * @param request - The frozen job request.
 * @param report - The actual report received from the ingest Worker.
 * @throws {Error} Until planned report validation is implemented.
 */
export function readMiniToolPlanJobReport(request: unknown, report: unknown): unknown {
  void request; void report;
  throw new Error("Planned job report validation is not implemented");
}
