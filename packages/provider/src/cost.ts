// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** A serializable handle to look a cost up later; its content belongs to the upstream that issued it. */
export interface CostLookup {
  upstream: string;
  [key: string]: unknown;
}

/** What one paid call cost (design 3.6). */
export type Cost =
  | { state: "known"; usd: number; source: "reported" | "billing" | "price_table" }
  | { state: "pending"; lookup: CostLookup }
  | { state: "missing"; reason: string };
