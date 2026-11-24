// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { db, env, enterpriseCreditPurchaseProfileSchema, enterpriseCreditPurchaseResultSchema, getEnterpriseMembershipProfile, lockRawMembershipSnapshot } from "@breatic/core";
import type { EnterpriseCreditPurchaseProfile, EnterpriseCreditPurchaseResult, EnterpriseCreditPurchaseWrite } from "@breatic/core";
import { creditLotService } from "@breatic/domain";
import * as operationRepo from "@server/modules/enterprise-credit-purchase/enterprise-credit-purchase.repo.js";

/** The authenticated original corporate purchase intent. */
export interface EnterpriseCreditPurchaseRequest { userId: string; key: string; hash: string; adminId: string; body: EnterpriseCreditPurchaseWrite }
/** The finite internal protocol, including original-key conflicts. */
export type EnterpriseCreditPurchaseAnswer<T> = { status: 200; body: T } | { status: 404; body: { code: "not_found" } } | { status: 409; body: { code: "idempotency_conflict" } };

/**
 * Read current eligibility and contract facts from one membership snapshot.
 * @param userId - The target account.
 * @returns Its validated purchase profile or an absent account.
 * @throws {Error} When the membership or database reading fails.
 */
export async function profile(userId: string): Promise<EnterpriseCreditPurchaseAnswer<EnterpriseCreditPurchaseProfile>> {
  const current = await getEnterpriseMembershipProfile(userId);
  if (current === null) return { status: 404, body: { code: "not_found" } };
  const enterpriseState = current.reading.enterpriseState;
  const reasons = { ordinary: "not_enterprise", expired: "enterprise_expired", missing: "enterprise_missing" } as const;
  const reason = enterpriseState === "active" ? env.CHARGING_ENABLED ? null : "payments_disabled" : reasons[enterpriseState];
  return { status: 200, body: enterpriseCreditPurchaseProfileSchema.parse({ account: current.account, enterpriseState,
    revision: current.snapshot.enterprise?.revision ?? null, contractNumber: current.snapshot.enterprise?.contractNumber ?? null,
    expiresAt: current.snapshot.enterprise?.expiresAt ?? null, canPurchase: reason === null, reason }) };
}

/**
 * Read the immutable creation decision under its original key.
 * @param key - The key saved by the back office.
 * @returns The known original result or an absent operation.
 * @throws {Error} When the database or stored decision fails.
 */
export async function operation(key: string): Promise<EnterpriseCreditPurchaseAnswer<EnterpriseCreditPurchaseResult>> {
  const stored = await operationRepo.findOperation(key);
  return stored === null ? { status: 404, body: { code: "not_found" } } : { status: 200, body: stored.result };
}

/**
 * Create corporate credits and the original decision in one transaction.
 * @param request - The validated original operator, target and contract snapshot.
 * @returns The exact original decision or a conflicting reuse of its key.
 * @throws {Error} When a write fails; the enclosing transaction rolls back.
 */
export async function purchase(request: EnterpriseCreditPurchaseRequest): Promise<EnterpriseCreditPurchaseAnswer<EnterpriseCreditPurchaseResult>> {
  return db.transaction(async tx => {
    await operationRepo.lockOperationKey(request.key, tx);
    const previous = await operationRepo.findOperation(request.key, tx);
    if (previous !== null) return previous.requestHash === request.hash ? { status: 200, body: previous.result } : { status: 409, body: { code: "idempotency_conflict" } };
    const snapshot = await lockRawMembershipSnapshot(request.userId, tx);
    const now = new Date();
    const operation = { key: request.key, accountId: request.userId, adminId: request.adminId, requestHash: request.hash, recordedAt: now.toISOString() };
    let result: EnterpriseCreditPurchaseResult;
    if (!env.CHARGING_ENABLED) result = { status: "refused", operation, code: "payments_disabled" };
    else if (snapshot === null) result = { status: "refused", operation, code: "account_not_found" };
    else if (snapshot.storedTier !== "enterprise") result = { status: "refused", operation, code: "not_enterprise" };
    else if (snapshot.enterprise === null) result = { status: "refused", operation, code: "enterprise_missing" };
    else if (Date.parse(snapshot.enterprise.expiresAt) <= now.getTime()) result = { status: "refused", operation, code: "enterprise_expired" };
    else if (snapshot.enterprise.revision !== request.body.expectedEnterpriseRevision || snapshot.enterprise.contractNumber !== request.body.expectedContractNumber) result = { status: "refused", operation, code: "enterprise_changed" };
    else result = { status: "applied", operation, ...await creditLotService.grantEnterpriseCredits({ userId: request.userId, credits: request.body.credits,
      contractNumber: snapshot.enterprise.contractNumber, reason: request.body.reason, operationKey: request.key, adminId: request.adminId }, tx) };
    result = enterpriseCreditPurchaseResultSchema.parse(result);
    await operationRepo.insertOperation({ ...request, result }, tx);
    return { status: 200, body: result };
  });
}
