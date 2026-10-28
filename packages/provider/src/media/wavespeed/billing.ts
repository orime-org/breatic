// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import { numberLeaf } from "@provider/cost.js";
import type { MediaWarning } from "@provider/media/runner.js";

/** A billing search answer, as far as it is read. */
const billingSchema = z.looseObject({
  data: z.looseObject({
    items: z.array(z.looseObject({ billing_type: z.string().optional(), order: z.looseObject({ price: numberLeaf }).nullish() })),
  }),
});

/** How a line moves the total: a deduction adds its price, a refund takes it back. */
const sign = z.enum(["deduct", "refund"]);

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
  const parsed = billingSchema.safeParse(body);
  if (!parsed.success) return { kind: "none", warnings: [] };
  const lines = parsed.data.data.items;
  if (!lines.some((line) => line.billing_type === "deduct")) return { kind: "none", warnings: [] };
  const warnings: MediaWarning[] = [];
  let total = 0;
  for (const line of lines) {
    const type = sign.safeParse(line.billing_type);
    if (!type.success) continue;
    const price = line.order?.price;
    if (price === undefined) {
      warnings.push({ code: "billing_line_without_price", detail: { billingType: line.billing_type } });
      continue;
    }
    total += (type.data === "deduct" ? 1 : -1) * price;
  }
  return { kind: "total", usd: Math.max(0, total), warnings };
}
