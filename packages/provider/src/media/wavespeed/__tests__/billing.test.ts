// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readBilling } from "../billing.js";

type Line = { billing_type: string; order: { price?: number } };
const answer = (items: Line[]): unknown => ({ code: 200, data: { items } });
const lineArb = fc.record({
  billing_type: fc.constantFrom("deduct", "refund", "adjust"),
  order: fc.record({ price: fc.double({ min: 0, max: 10, noNaN: true }) }),
});

describe("readBilling (design 6.2, 13.1 actual cost)", () => {
  it("property: with a deduction, the total is deductions less refunds, never below zero", () => {
    fc.assert(fc.property(fc.array(lineArb, { maxLength: 8 }), (lines) => {
      const read = readBilling(answer(lines));
      const sum = lines.reduce((t, l) => t + (l.billing_type === "deduct" ? 1 : l.billing_type === "refund" ? -1 : 0) * (l.order.price ?? 0), 0);
      if (!lines.some((l) => l.billing_type === "deduct")) {
        expect(read.kind).toBe("none");
        return;
      }
      expect(read.kind).toBe("total");
      if (read.kind === "total") {
        expect(read.usd).toBeCloseTo(Math.max(0, sum), 9);
        expect(read.usd).toBeGreaterThanOrEqual(0);
      }
    }));
  });

  it("warns about a deducting line without a price and counts the others", () => {
    const read = readBilling(answer([{ billing_type: "deduct", order: { price: 0.01 } }, { billing_type: "deduct", order: {} }]));
    expect(read).toMatchObject({ kind: "total", usd: 0.01 });
    expect(read.warnings.map((w) => w.code)).toEqual(["billing_line_without_price"]);
  });

  it.each([[null], [{}], [{ data: [{ price: 9.99 }] }], ["text"]])("answers none for a body it cannot read: %j", (body) => {
    expect(readBilling(body).kind).toBe("none");
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("leaves out a line of type %s, which names no sign of its own (DD 33)", (type) => {
    const read = readBilling(answer([{ billing_type: "deduct", order: { price: 0.1 } }, { billing_type: type, order: { price: 0.1 } }]));
    expect(read).toMatchObject({ kind: "total", usd: 0.1 });
  });

  it("reads a price JSON cannot hold as no price, never a known Infinity", () => {
    const read = readBilling({ code: 200, data: { items: [{ billing_type: "deduct", order: { price: 0.1 } }, { billing_type: "deduct", order: { price: Number.POSITIVE_INFINITY } }] } });
    expect(read).toMatchObject({ kind: "total", usd: 0.1 });
    expect(read.warnings.map((w) => w.code)).toEqual(["billing_line_without_price"]);
  });
});
