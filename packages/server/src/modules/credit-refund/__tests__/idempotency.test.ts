// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The request fingerprint kept in `request_hash` (inner#1410 §4.6,
 * acceptance #6): `sha256(method \n route template \n target id \n canonical
 * JSON body)`, hex. A key reused by a request that differs in any of the four
 * is refused 422, so each one must change the fingerprint on its own.
 *
 * The method is pinned here rather than over HTTP: every write route is POST
 * and anything else on a write path is 403 at the authorisation table, so no
 * second method can carry a key to the lookup. If a write route ever takes
 * another method, this is what keeps the two from sharing a fingerprint.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fingerprint } from "@server/modules/credit-refund/idempotency.js";

const TEMPLATE = "/internal/v1/credit-lots/:lotId/refund/approve";
const LOT = "00000000-0000-4000-8000-000000000001";
const BODY = { reason: "Unused, within 14 days.", confirmedRefundIds: [] as string[] };

describe("fingerprint", () => {
  it("is the hex sha256 of method, template, target and canonical body joined by newlines", () => {
    const expected = createHash("sha256")
      .update(["POST", TEMPLATE, LOT, '{"confirmedRefundIds":[],"reason":"Unused, within 14 days."}'].join("\n"))
      .digest("hex");

    expect(fingerprint("POST", TEMPLATE, LOT, BODY)).toBe(expected);
  });

  it.each(["GET", "PUT", "PATCH", "DELETE", "HEAD", "post"])(
    "differs when only the method differs: POST vs %s",
    (method) => {
      expect(fingerprint(method, TEMPLATE, LOT, BODY)).not.toBe(fingerprint("POST", TEMPLATE, LOT, BODY));
    },
  );

  it("differs when only the route template, the target or the body differs", () => {
    const base = fingerprint("POST", TEMPLATE, LOT, BODY);

    expect(fingerprint("POST", "/internal/v1/credit-lots/:lotId/refund/reject", LOT, BODY)).not.toBe(base);
    expect(fingerprint("POST", TEMPLATE, "00000000-0000-4000-8000-000000000002", BODY)).not.toBe(base);
    expect(fingerprint("POST", TEMPLATE, LOT, { ...BODY, reason: "Different." })).not.toBe(base);
  });

  it("is the same for the same fields in another order, nested ones included", () => {
    expect(fingerprint("POST", TEMPLATE, LOT, { reason: "r", nested: { b: 1, a: [{ y: 2, x: 1 }] } })).toBe(
      fingerprint("POST", TEMPLATE, LOT, { nested: { a: [{ x: 1, y: 2 }], b: 1 }, reason: "r" }),
    );
  });
});
