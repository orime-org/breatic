// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { DueMiniToolSettlement, MiniToolConsumptionLookup, MiniToolConsumptionLookupInput } from "@domain/mini-tool/consumption.types.js";
import type { MiniToolChargeResult } from "@domain/mini-tool/settlement.service.js";

/** A committed cycle's current wake, independent charge result and application diagnostic. */
export interface MiniToolSettlementRunResult {
  nextWake: DueMiniToolSettlement | null;
  charge: MiniToolChargeResult | null;
  failure?: unknown;
}

/** One external read outside any SQL transaction, supplied by the worker application. */
export type MiniToolSettlementLookup = (input: MiniToolConsumptionLookupInput) => Promise<MiniToolConsumptionLookup>;
/** Queue delivery carries only the original task and current SQL cycle. */
export type MiniToolSettlementWake = Pick<DueMiniToolSettlement, "taskId" | "settlementVersion">;

/**
 * Resume one durable expense or final charge under its own committed SQL lease.
 * @param input - The wake's immutable task and settlement version.
 * @param lookup - Original-identity lookup, with no ability to submit media work.
 * @returns The next current waiting identity and any independently committed charge.
 * @throws {Error} When validation or persistence prevents durable recovery.
 */
export async function runMiniToolSettlement(input: MiniToolSettlementWake, lookup: MiniToolSettlementLookup): Promise<MiniToolSettlementRunResult> {
  void input; void lookup;
  throw new Error("Mini-tool settlement orchestration awaits independent RED");
}
