// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from "zod";

/** The backend queue only wakes durable SQL expense periods. */
export const MINI_TOOL_SETTLEMENT_QUEUE = "mini-tool-settlement";
export const MINI_TOOL_SETTLEMENT_JOB = "settle-mini-tool-expense";
export const MINI_TOOL_SETTLEMENT_DISCOVERY_JOB = "discover-mini-tool-expenses";

/** A wake never contains a replacement quote or computation request. */
export const miniToolSettlementWakeSchema = z.strictObject({ taskId: z.uuid(), settlementVersion: z.number().int().nonnegative() });
/** Discovery retains the full SQL cursor without turning it into a Date. */
export const miniToolSettlementDiscoverySchema = z.strictObject({
  cursor: z.strictObject({ taskId: z.uuid(), dueAt: z.iso.datetime({ precision: 6 }) }).optional(),
});
export type MiniToolSettlementWake = z.infer<typeof miniToolSettlementWakeSchema>;
export type MiniToolSettlementDiscovery = z.infer<typeof miniToolSettlementDiscoverySchema>;
