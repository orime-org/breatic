// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProviderConfig } from "@provider/config/schema.js";
import type { Cost, CostLookup } from "@provider/cost.js";
import type { ProviderOptions } from "@provider/provider.js";

/**
 * Ask the upstream again for a cost that was pending.
 * @param config - The validated configuration.
 * @param options - The caller's options.
 * @param lookup - The handle.
 * @param lastAttempt - Whether this is the last time it is asked.
 * @returns The cost.
 */
export async function lookupCost(config: ProviderConfig, options: ProviderOptions, lookup: CostLookup, lastAttempt: boolean): Promise<Cost> {
  void config; void options; void lookup; void lastAttempt;
  throw new Error("cost.lookup is not implemented");
}
