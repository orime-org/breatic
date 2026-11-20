// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { expect } from "vitest";
import { call } from "./internal-api-harness.js";
import type { InternalSuite, CallResult } from "./internal-api-harness.js";
import { seedPersonal, GRANT_ADMIN } from "./operator-credit-grant-fixtures.js";
import type { PersonalFixture } from "./operator-credit-grant-fixtures.js";

export type Sql = ReturnType<typeof postgres>;
export const ENTERPRISE_BODY = { credits: "100.05", reason: "Corporate remittance confirmed", expectedEnterpriseRevision: 1, expectedContractNumber: "ENTERPRISE-174" };
export const MEMBERSHIP_BODY = { targetTier: "enterprise", expiresAt: "2099-01-01T00:00:00.000Z", entryTimezone: "UTC", contractNumber: ENTERPRISE_BODY.expectedContractNumber,
  limits: { team_studios: 8, projects_per_studio: 500, concurrent_editors: 30, studio_members: 200, project_members: 80, storage_bytes: 1099511627776 }, expectedRevision: null, expectedStoredTier: "base" };

/** One independently confirmed purchase UUID. */
export function purchaseKey(): string { return `bo-${randomUUID()}`; }
/** The agreed account purchase endpoint. */
export function purchasePath(id: string): string { return `/internal/v1/accounts/${id}/enterprise-credit-purchases`; }
/** The immutable original decision endpoint. */
export function purchaseOperationPath(key: string): string { return `/internal/v1/enterprise-credit-purchase-operations/${key}`; }

/** Seed an active enterprise through the existing signed membership API. */
export async function enterpriseFixture(suite: InternalSuite): Promise<PersonalFixture> {
  const fx = await seedPersonal(suite.sql, "enterprise-purchase");
  const response = await call(suite.baseUrl, `/internal/v1/accounts/${fx.userId}/enterprise-membership`, { body: MEMBERSHIP_BODY, idempotencyKey: purchaseKey(), admin: GRANT_ADMIN });
  expect(response.status).toBe(200);
  expect(response.json.status).toBe("applied");
  return fx;
}

/** Send exactly the confirmed intent and the original actor. */
export async function postPurchase(suite: InternalSuite, userId: string, key: string, body = ENTERPRISE_BODY, admin = GRANT_ADMIN): Promise<CallResult> {
  return call(suite.baseUrl, purchasePath(userId), { body, idempotencyKey: key, admin });
}

/** Independently fingerprint all original purchase facts. */
export function purchaseHash(userId: string, adminId: string, body = ENTERPRISE_BODY): string {
  const canonical = JSON.stringify({ adminId, body: { credits: body.credits, expectedContractNumber: body.expectedContractNumber, expectedEnterpriseRevision: body.expectedEnterpriseRevision, reason: body.reason } });
  return createHash("sha256").update(["POST", "/internal/v1/accounts/:userId/enterprise-credit-purchases", userId, canonical].join("\n")).digest("hex");
}

/** Assert real product schema and a single immutable funding bundle. */
export async function expectPurchase(suite: InternalSuite, userId: string, key: string, response: CallResult, body = ENTERPRISE_BODY): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.json).toEqual({ status: "applied", operation: { key, accountId: userId, adminId: GRANT_ADMIN, requestHash: purchaseHash(userId, GRANT_ADMIN, body), recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) },
    sourceId: expect.stringMatching(/^[a-f0-9-]{36}$/), sourceKind: "enterprise", lotId: expect.stringMatching(/^[a-f0-9-]{36}$/), credits: `${body.credits}0000`, contractNumber: body.expectedContractNumber, designatedStudioId: null, remainingCredits: `${body.credits}0000` });
  const { sourceId, lotId } = response.json;
  expect(await suite.sql`select kind from credit_sources where id=${sourceId}`).toEqual([{ kind: "enterprise" }]);
  expect(await suite.sql`select source_kind,target_user_id,credits::text,contract_number,reason,operation_key,requested_by from credit_enterprise_purchases where id=${sourceId}`)
    .toEqual([{ source_kind: "enterprise", target_user_id: userId, credits: `${body.credits}0000`, contract_number: body.expectedContractNumber, reason: body.reason, operation_key: key, requested_by: GRANT_ADMIN }]);
  expect(await suite.sql`select source_id,source_kind,user_id,purchased_credits::text,remaining_credits::text,designated_studio_id from credit_lots where id=${lotId}`)
    .toEqual([{ source_id: sourceId, source_kind: "enterprise", user_id: userId, purchased_credits: `${body.credits}0000`, remaining_credits: `${body.credits}0000`, designated_studio_id: null }]);
  expect(await suite.sql`select payer_user_id,entry_type,amount::text from credit_ledger where lot_id=${lotId}`).toEqual([{ payer_user_id: userId, entry_type: "topup", amount: `${body.credits}0000` }]);
  expect(await suite.sql`select request_hash,target_user_id,requested_by,request_body,result from enterprise_credit_purchase_operations where key=${key}`)
    .toEqual([{ request_hash: purchaseHash(userId, GRANT_ADMIN, body), target_user_id: userId, requested_by: GRANT_ADMIN, request_body: body, result: response.json }]);
}
