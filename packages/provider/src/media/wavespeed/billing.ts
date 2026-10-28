// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { usdOf } from "@provider/cost.js";
import type { MediaWarning } from "@provider/media/runner.js";

/** One line of a billing search answer. */
interface BillingLine {
  billing_type?: string;
  order?: { price?: unknown };
}

/** How a line moves the total: a deduction adds its price, a refund takes it back. */
const SIGN: Readonly<Record<string, number>> = { deduct: 1, refund: -1 };

/** What WaveSpeed's billing search answered for one prediction. */
export type BillingRead =
  | { kind: "total"; usd: number; warnings: MediaWarning[] }
  | { kind: "none"; warnings: MediaWarning[] };

/**
 * Read a billing search answer: deductions less refunds, never below zero;
 * lines of any other type left out; no deduction at all is no answer yet.
 * @param body - The parsed response body.
 * @returns The total, or none.
 */
export function readBilling(body: unknown): BillingRead {
  const items = (body as { data?: { items?: unknown } } | null | undefined)?.data?.items;
  if (typeof body !== "object" || body === null || !Array.isArray(items)) return { kind: "none", warnings: [] };
  const lines = items as BillingLine[];
  if (!lines.some((line) => line?.billing_type === "deduct")) return { kind: "none", warnings: [] };
  const warnings: MediaWarning[] = [];
  let total = 0;
  for (const line of lines) {
    const sign = SIGN[line?.billing_type ?? ""];
    if (sign === undefined) continue;
    const price = usdOf(line.order?.price);
    if (price === undefined) {
      warnings.push({ code: "billing_line_without_price", detail: { billingType: line.billing_type } });
      continue;
    }
    total += sign * price;
  }
  return { kind: "total", usd: Math.max(0, total), warnings };
}
