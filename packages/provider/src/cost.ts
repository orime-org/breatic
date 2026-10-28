// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

/** A number leaf of an upstream answer: a value that is not a finite number reads as absent. */
export const numberLeaf = z.number().optional().catch(undefined);

/** A serializable handle to look a cost up later; its content belongs to the upstream that issued it. */
export interface CostLookup {
  upstream: string;
  [key: string]: unknown;
}

/** The token buckets one model call used; reasoning is part of output. */
export interface TokenBuckets {
  input: number;
  cachedInput: number;
  output: number;
  reasoning: number;
}

/** What one paid call cost (design 3.6). */
export type Cost =
  | { state: "known"; usd: number; tokens?: TokenBuckets; source: "reported" | "billing" | "price_table" }
  | { state: "pending"; lookup: CostLookup }
  | { state: "missing"; reason: string; tokens?: TokenBuckets };

