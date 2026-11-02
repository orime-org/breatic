// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { db, env, creditGrantProfileSchema, creditGrantResultSchema } from "@breatic/core";
import type { CreditGrantProfile, CreditGrantResult, CreditGrantWrite, DbTx } from "@breatic/core";
import { serializeCreditMicro, parseCreditDecimal } from "@breatic/shared";
import { creditLotService, creditLotRepo, studioMembersRepo } from "@breatic/domain";
import * as operationRepo from "@server/modules/credit-grant/credit-grant.repo.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";

/** The signed original request identity and normalized intent. */
export interface GrantRequest { userId: string; key: string; hash: string; adminId: string; body: CreditGrantWrite }
/** A finite internal service response. */
export type GrantAnswer<T> = { status: 200; body: T } | { status: 404; body: { code: "not_found" } } | { status: 409; body: { code: "idempotency_conflict" } };

/**
 * Resolve and hold the complete grant identity in the established lock order.
 * @param userId - The target product account UUID.
 * @param tx - The transaction holding the identity and funding locks.
 * @returns A current identity or the finite reason it cannot receive funding.
 * @throws {Error} When an identity lock cannot be acquired.
 */
async function lockIdentity(userId: string, tx: DbTx): Promise<
  { account: NonNullable<Awaited<ReturnType<typeof userRepo.lockGrantAccount>>>; studio: Awaited<ReturnType<typeof studioRepo.lockPersonalForGrant>>; code: "personal_studio_unavailable" | null }
  | { account: null; studio: null; code: "account_not_found" }
> {
  const account = await userRepo.lockGrantAccount(userId, tx);
  if (account === null) return { account: null, studio: null, code: "account_not_found" };
  const studio = await studioRepo.lockPersonalForGrant(userId, tx);
  if (studio === null) return { account, studio: null, code: "personal_studio_unavailable" };
  const role = await studioMembersRepo.lockGrantMemberRole(studio.id, userId, tx);
  return { account, studio: role === "admin" ? studio : null, code: role === "admin" ? null : "personal_studio_unavailable" };
}

/**
 * Read the account's current personal Studio and debt from a coherent identity.
 * @param userId - The target product account UUID.
 * @returns Its contract-checked profile, or a missing-account response.
 * @throws {Error} When the database or stored profile fails.
 */
export async function profile(userId: string): Promise<GrantAnswer<CreditGrantProfile>> {
  return db.transaction(async (tx) => {
    const identity = await lockIdentity(userId, tx);
    if (identity.account === null) return { status: 404, body: { code: "not_found" } };
    const studio = identity.studio;
    return { status: 200, body: creditGrantProfileSchema.parse({
      account: { id: identity.account.id, email: identity.account.email },
      personalStudio: studio === null ? null : { id: studio.id, name: studio.name, slug: studio.slug },
      debtCredits: studio === null ? null : serializeCreditMicro(parseCreditDecimal(await creditLotRepo.readDebt(studio.id, tx))),
      canGrant: studio !== null && env.PAYMENT_ENABLED,
      reason: studio === null ? "personal_studio_unavailable" : env.PAYMENT_ENABLED ? null : "payments_disabled",
    }) };
  });
}

/**
 * Recover the committed original decision without recalculating balances.
 * @param key - The stable original request key.
 * @returns The stored result or a currently absent operation.
 * @throws {Error} When the database or result contract fails.
 */
export async function operation(key: string): Promise<GrantAnswer<CreditGrantResult>> {
  const previous = await operationRepo.findOperation(key);
  return previous === null ? { status: 404, body: { code: "not_found" } } : { status: 200, body: previous.result };
}

/**
 * Commit one original decision together with every funding and repayment fact.
 * @param request - The signed identity and normalized original intent.
 * @returns Its original result, or a conflict when another intent owns the key.
 * @throws {Error} When any write fails; the enclosing transaction rolls back.
 */
export async function grant(request: GrantRequest): Promise<GrantAnswer<CreditGrantResult>> {
  return db.transaction(async (tx): Promise<GrantAnswer<CreditGrantResult>> => {
    await operationRepo.lockOperationKey(request.key, tx);
    const previous = await operationRepo.findOperation(request.key, tx);
    if (previous !== null) return previous.requestHash === request.hash
      ? { status: 200, body: previous.result } : { status: 409, body: { code: "idempotency_conflict" } };
    const operation = { key: request.key, accountId: request.userId, adminId: request.adminId, requestHash: request.hash, recordedAt: new Date().toISOString() };
    let result: CreditGrantResult;
    if (!env.PAYMENT_ENABLED) result = { status: "refused", operation, code: "payments_disabled" };
    else {
      const identity = await lockIdentity(request.userId, tx);
      if (identity.code !== null) result = { status: "refused", operation, code: identity.code };
      else if (identity.studio!.id !== request.body.expectedPersonalStudioId) result = { status: "refused", operation, code: "personal_studio_changed" };
      else result = { status: "applied", operation, ...await creditLotService.grantOperatorCredits({
        userId: request.userId, studioId: identity.studio!.id, kind: request.body.kind, credits: request.body.credits,
        reason: request.body.reason, operationKey: request.key, adminId: request.adminId,
      }, tx) };
    }
    result = creditGrantResultSchema.parse(result);
    await operationRepo.insertOperation({ ...request, result }, tx);
    return { status: 200, body: result };
  });
}
