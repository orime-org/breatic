// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolConsumptionRecord } from "@breatic/domain";
import type { MiniToolPlanJobRequest, UntilDeadline } from "@breatic/shared";

/** Original consumption and the immutable request needed to authenticate a container report. */
export interface MiniToolConsumptionLookupInput {
  consumption: MiniToolConsumptionRecord;
  plan?: MiniToolPlanJobRequest;
}

/** An unresolved expense is distinct from a positively confirmed zero. */
export type MiniToolConsumptionLookup =
  | { state: "pending"; reason: string }
  | { state: "known"; costUsd: number; costSource: "generation_lookup" | "computed"; raw: unknown };

/**
 * Read one original upstream identity without submitting or changing computation.
 * @param input - The durable consumption and any original planned request.
 * @param bound - This read's lifetime, independent of the completed computation deadline.
 * @returns Confirmed actual expense or an explicitly unresolved result.
 * @throws {Error} When configuration, identity, transport or report validation fails.
 */
export async function lookupMiniToolConsumption(input: MiniToolConsumptionLookupInput, bound: UntilDeadline): Promise<MiniToolConsumptionLookup> {
  void input; void bound;
  throw new Error("Mini-tool consumption lookup is not implemented");
}
