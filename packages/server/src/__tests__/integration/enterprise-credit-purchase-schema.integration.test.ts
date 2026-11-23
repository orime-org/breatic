// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { useInternalApp } from "./internal-api-harness.js";
import { GRANT_ADMIN } from "./operator-credit-grant-fixtures.js";
import { ENTERPRISE_BODY, enterpriseFixture, postPurchase, purchaseKey } from "./enterprise-credit-purchase.fixture.js";

const suite = useInternalApp("enterprise-credit-schema");

describe("enterprise purchase source constraints", () => {
  it.each([
    ["quantity below minimum", { credits: "0" }, "23514"],
    ["quantity outside column", { credits: "100000000000000.00" }, "22003"],
    ["quantity outside input precision", { credits: "0.001" }, "23514"],
    ["empty contract", { contract: "" }, "23514"],
    ["oversized contract", { contract: "x".repeat(129) }, "23514"],
    ["empty reason", { reason: " " }, "23514"],
    ["oversized reason", { reason: "x".repeat(501) }, "23514"],
    ["wrong child kind", { sourceKind: "gift" }, "23514"],
    ["wrong parent kind", { parentKind: "payment" }, "23503"],
    ["absent source", { parent: false }, "23503"],
    ["absent decision", { decision: false }, "23503"],
    ["absent account", { userId: randomUUID() }, "23503"],
  ] as const)("rejects %s atomically", async (_label, change, code) => {
    const fx = await enterpriseFixture(suite);
    const changes: { credits?: string; contract?: string; reason?: string; sourceKind?: string; parentKind?: string; parent?: boolean; decision?: boolean; userId?: string } = change;
    const sourceId = randomUUID();const key = purchaseKey();
    await expect(suite.sql.begin(async tx => {
      if (changes.parent !== false) await tx`insert into credit_sources(id,kind) values(${sourceId},${changes.parentKind ?? "enterprise"})`;
      if (changes.decision !== false) await tx`insert into enterprise_credit_purchase_operations(key,request_hash,target_user_id,requested_by,request_body,result)
        values(${key},${"a".repeat(64)},${fx.userId},${GRANT_ADMIN},${tx.json(ENTERPRISE_BODY)},${tx.json({ status: "refused" })})`;
      await tx`insert into credit_enterprise_purchases(id,source_kind,target_user_id,credits,contract_number,reason,operation_key,requested_by)
        values(${sourceId},${changes.sourceKind ?? "enterprise"},${changes.userId ?? fx.userId},${changes.credits ?? "100.050000"}::numeric,
        ${changes.contract ?? "ENTERPRISE-174"},${changes.reason ?? "Confirmed corporate purchase"},${key},${GRANT_ADMIN})`;
    })).rejects.toMatchObject({ code });
    expect(await suite.sql`select id from credit_sources where id=${sourceId}`).toEqual([]);
    expect(await suite.sql`select key from enterprise_credit_purchase_operations where key=${key}`).toEqual([]);
  });

  it("permits one source receipt and one lot for an original operation", async () => {
    const fx = await enterpriseFixture(suite);const key = purchaseKey();const response = await postPurchase(suite, fx.userId, key);
    expect(response.status).toBe(200);
    await expect(suite.sql.begin(async tx => {
      const sourceId = randomUUID();await tx`insert into credit_sources(id,kind) values(${sourceId},'enterprise')`;
      await tx`insert into credit_enterprise_purchases(id,target_user_id,credits,contract_number,reason,operation_key,requested_by)
        values(${sourceId},${fx.userId},100.05,'ENTERPRISE-174','Duplicate purchase',${key},${GRANT_ADMIN})`;
    })).rejects.toMatchObject({ code: "23505" });
    await expect(suite.sql`insert into credit_lots(source_id,source_kind,user_id,purchased_credits,remaining_credits,lifecycle)
      values(${response.json.sourceId},'enterprise',${fx.userId},100.05,100.05,'active')`).rejects.toMatchObject({ code: "23505" });
    expect(await suite.sql`select id from credit_lots where user_id=${fx.userId}`).toHaveLength(1);
  });

  it("retains creation timestamps on the immutable receipts and decisions", async () => {
    for (const table of ["credit_enterprise_purchases", "enterprise_credit_purchase_operations"]) {
      const columns = await suite.sql`select column_name,is_nullable from information_schema.columns where table_schema='public' and table_name=${table}`;
      expect(columns).toContainEqual({ column_name: "created_at", is_nullable: "NO" });
      expect(columns.find(row => row.column_name === "deleted_at")).toBeUndefined();
    }
  });
});
