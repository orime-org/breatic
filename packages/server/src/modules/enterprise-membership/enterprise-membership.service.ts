// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { changeMembershipTier, db, enterpriseMembershipResultSchema, getEnterpriseMembershipProfile, lockRawMembershipSnapshot, writeEnterpriseMembershipRecord } from "@breatic/core";
import type { EnterpriseMembershipProfile, EnterpriseMembershipResult, EnterpriseMembershipWrite } from "@breatic/core";
import * as operationRepo from "@server/modules/enterprise-membership/enterprise-membership.repo.js";

/** The signed identity and validated facts of one save. */
export interface MembershipSaveRequest {
  userId: string;
  key: string;
  hash: string;
  adminId: string;
  body: EnterpriseMembershipWrite;
}

/** A finite internal response whose successful body is contract checked. */
export type MembershipAnswer<T> =
  | { status: 200; body: T }
  | { status: 404; body: { code: "not_found" } }
  | { status: 409; body: { code: "idempotency_conflict" } };

/**
 * Read current membership facts and effective entitlement from one snapshot.
 * @param userId - The target account.
 * @returns The current profile or a missing-account response.
 * @throws {Error} When the database or membership configuration is unavailable.
 */
export async function profile(userId: string): Promise<MembershipAnswer<EnterpriseMembershipProfile>> {
  const body = await getEnterpriseMembershipProfile(userId);
  return body === null ? { status: 404, body: { code: "not_found" } } : { status: 200, body };
}

/**
 * Read the original committed result without recalculating current entitlement.
 * @param key - The request key retained by the back office.
 * @returns The original result or the currently missing record.
 * @throws {Error} When the database fails or the stored result is invalid.
 */
export async function operation(key: string): Promise<MembershipAnswer<EnterpriseMembershipResult>> {
  const found = await operationRepo.findOperation(key);
  return found === null ? { status: 404, body: { code: "not_found" } } : { status: 200, body: found.result };
}

/**
 * Save all membership facts and the original response as one atomic decision.
 * @param request - The authenticated request identity and validated facts.
 * @returns Its immutable result, or a refusal of a differently used key.
 * @throws {Error} When any database write fails; the enclosing transaction rolls back.
 */
export async function save(request: MembershipSaveRequest): Promise<MembershipAnswer<EnterpriseMembershipResult>> {
  return db.transaction(async (tx): Promise<MembershipAnswer<EnterpriseMembershipResult>> => {
    await operationRepo.lockOperationKey(request.key, tx);
    const previous = await operationRepo.findOperation(request.key, tx);
    if (previous !== null) {
      return previous.requestHash === request.hash
        ? { status: 200, body: previous.result }
        : { status: 409, body: { code: "idempotency_conflict" } };
    }

    const before = await lockRawMembershipSnapshot(request.userId, tx);
    const metadata = { key: request.key, accountId: request.userId, adminId: request.adminId, requestHash: request.hash, recordedAt: new Date().toISOString() };
    let result: EnterpriseMembershipResult;
    if (before === null) {
      result = { status: "refused", operation: metadata, code: "account_not_found", before: null, after: null };
    } else if (before.storedTier !== request.body.expectedStoredTier || (before.enterprise?.revision ?? null) !== request.body.expectedRevision) {
      result = { status: "refused", operation: metadata, code: "revision_conflict", before, after: before };
    } else {
      const fallbackTier = before.storedTier === "enterprise"
        ? before.enterprise?.fallbackTier ?? "base"
        : before.storedTier === "self_hosted" ? "self_hosted" : "base";
      const enterprise = await writeEnterpriseMembershipRecord(request.userId, request.body, fallbackTier, (before.enterprise?.revision ?? 0) + 1, tx);
      await changeMembershipTier(request.userId, "enterprise", "manual", request.key, tx);
      result = { status: "applied", operation: metadata, before, after: { userId: request.userId, storedTier: "enterprise", enterprise } };
    }
    result = enterpriseMembershipResultSchema.parse(result);
    await operationRepo.insertOperation({ ...request, result }, tx);
    return { status: 200, body: result };
  });
}
