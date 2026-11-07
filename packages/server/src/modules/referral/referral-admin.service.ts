// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { db, decodeActivityCursor } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { CreditPage } from "@breatic/shared";
import {
  decideApplication,
  findApplicationDetail,
  listApplications,
  lockApplication,
} from "@server/modules/referral/promoter-application.repo.js";
import type { ApplicationDetail, PromoterApplicationStatus } from "@server/modules/referral/promoter-application.repo.js";
import { generateReferralCode, parseReferralCode } from "@server/modules/referral/referral-code.js";
import { insertCode, listCodes, lockCode, setCodeStatus } from "@server/modules/referral/referral-code.repo.js";
import type { ReferralCodeStatus } from "@server/modules/referral/referral-code.repo.js";
import { findOperation, insertOperation, lockOperationKey } from "@server/modules/referral/referral-operation.repo.js";
import type { ReferralOperationKind, ReferralOperationResult } from "@server/modules/referral/referral-operation.repo.js";
import { toPage } from "@server/utils/keyset-page.js";

const GENERATION_ATTEMPTS = 5;

/** An answer the internal route sends as it is. */
export interface Answer {
  status: 200 | 404 | 409;
  body: object;
}

/** What every back-office write carries besides its body. */
export interface WriteRequest {
  key: string;
  hash: string;
  adminId: string;
}

const NOT_FOUND: Answer = { status: 404, body: { code: "not_found" } };

/**
 * Runs one back-office write once per key, storing its answer in the same transaction.
 * @param req - Key, fingerprint and operator.
 * @param kind - Which write.
 * @param targetId - The application or code written to.
 * @param body - The request body, stored with the answer.
 * @param act - The write; null when its target does not exist.
 * @returns The original answer on a replay, 409 for a reused key with another body, 404 for a missing target.
 * @throws {Error} if the database fails.
 */
async function runOnce(
  req: WriteRequest,
  kind: ReferralOperationKind,
  targetId: string,
  body: Record<string, unknown>,
  act: (tx: DbTx) => Promise<ReferralOperationResult | null>,
): Promise<Answer> {
  return db.transaction(async (tx): Promise<Answer> => {
    await lockOperationKey(req.key, tx);
    const previous = await findOperation(req.key, tx);
    if (previous !== null) {
      return previous.requestHash === req.hash
        ? { status: 200, body: previous.result }
        : { status: 409, body: { code: "idempotency_conflict" } };
    }
    const result = await act(tx);
    if (result === null) return NOT_FOUND;
    await insertOperation({ key: req.key, kind, targetId, hash: req.hash, adminId: req.adminId, body, result }, tx);
    return { status: 200, body: result };
  });
}

/**
 * Issues the asked-for code, or draws one until a free one turns up.
 * @param input - The asked-for code, if any, and the approval.
 * @param input.asked - Raw code the operator typed, or undefined.
 * @param input.promoterId - The applicant.
 * @param input.applicationId - The application.
 * @param tx - The approval's transaction.
 * @returns The issued code, or why none was.
 */
async function issueCode(
  input: { asked: string | undefined; promoterId: string; applicationId: string },
  tx: DbTx,
): Promise<{ code: string } | { refused: "invalid_code" | "code_taken" | "code_generation_failed" }> {
  if (input.asked !== undefined) {
    const code = parseReferralCode(input.asked);
    if (code === null) return { refused: "invalid_code" };
    const id = await insertCode({ code, promoterId: input.promoterId, applicationId: input.applicationId }, tx);
    return id === null ? { refused: "code_taken" } : { code };
  }
  for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();
    const id = await insertCode({ code, promoterId: input.promoterId, applicationId: input.applicationId }, tx);
    if (id !== null) return { code };
  }
  return { refused: "code_generation_failed" };
}

/**
 * Approves a pending application and issues its promoter a code.
 * @param applicationId - The application.
 * @param body - Why, and the code asked for if any.
 * @param body.reason - Recorded for the back office.
 * @param body.code - The code the operator chose, if any.
 * @param req - Key, fingerprint and operator.
 * @returns applied with the code, or refused with why.
 * @throws {Error} if the database fails.
 */
export async function approve(applicationId: string, body: { reason: string; code?: string }, req: WriteRequest): Promise<Answer> {
  return runOnce(req, "approve", applicationId, body, async (tx) => {
    const application = await lockApplication(applicationId, tx);
    if (application === null) return null;
    if (application.status !== "pending") return { status: "refused", code: "not_pending" };
    const issued = await issueCode({ asked: body.code, promoterId: application.userId, applicationId }, tx);
    if ("refused" in issued) return { status: "refused", code: issued.refused };
    await decideApplication({ id: applicationId, status: "approved", adminId: req.adminId, reason: body.reason, applicantNote: null }, tx);
    return { status: "applied", referralCode: issued.code };
  });
}

/**
 * Rejects a pending application, optionally with a note the applicant reads.
 * @param applicationId - The application.
 * @param body - Why, and the note.
 * @param body.reason - Recorded for the back office.
 * @param body.applicantNote - Shown to the applicant, if any.
 * @param req - Key, fingerprint and operator.
 * @returns applied, or refused when it is no longer pending.
 * @throws {Error} if the database fails.
 */
export async function reject(
  applicationId: string,
  body: { reason: string; applicantNote?: string },
  req: WriteRequest,
): Promise<Answer> {
  return runOnce(req, "reject", applicationId, body, async (tx) => {
    const application = await lockApplication(applicationId, tx);
    if (application === null) return null;
    if (application.status !== "pending") return { status: "refused", code: "not_pending" };
    await decideApplication(
      { id: applicationId, status: "rejected", adminId: req.adminId, reason: body.reason, applicantNote: body.applicantNote ?? null },
      tx,
    );
    return { status: "applied" };
  });
}

/** Which status each code write moves to, and what it refuses from where. */
const CODE_WRITES: Record<"disable" | "enable" | "remove", { to: ReferralCodeStatus; refuse: Partial<Record<ReferralCodeStatus, string>> }> = {
  disable: { to: "disabled", refuse: { disabled: "already_disabled", removed: "removed" } },
  enable: { to: "active", refuse: { active: "already_active", removed: "removed" } },
  remove: { to: "removed", refuse: { removed: "already_removed" } },
};

/**
 * Disables, re-enables or removes a promoter's code.
 * @param action - Which write.
 * @param codeId - The code row.
 * @param body - Why.
 * @param body.reason - Recorded for the back office.
 * @param req - Key, fingerprint and operator.
 * @returns applied, or refused with why.
 * @throws {Error} if the database fails.
 */
export async function writeCode(
  action: "disable" | "enable" | "remove",
  codeId: string,
  body: { reason: string },
  req: WriteRequest,
): Promise<Answer> {
  const rule = CODE_WRITES[action];
  return runOnce(req, action, codeId, body, async (tx) => {
    const code = await lockCode(codeId, tx);
    if (code === null) return null;
    const refusal = rule.refuse[code.status];
    if (refusal !== undefined) return { status: "refused", code: refusal };
    await setCodeStatus(codeId, rule.to, tx);
    return { status: "applied" };
  });
}

/**
 * The original answer stored under a key.
 * @param key - The idempotency key.
 * @returns 200 with it, or 404 for a key never used.
 */
export async function operation(key: string): Promise<Answer> {
  const previous = await findOperation(key);
  return previous === null ? NOT_FOUND : { status: 200, body: previous.result };
}

/**
 * Reads the position a cursor names; a malformed one starts from the top.
 * @param cursor - Opaque cursor, if any.
 * @returns The position, or null for the first page.
 */
function after(cursor: string | undefined): { createdAt: string; id: string } | null {
  return cursor === undefined ? null : decodeActivityCursor(cursor);
}

/**
 * A page of applications for review, newest first.
 * @param query - Filter, page size and cursor.
 * @param query.status - Only this status, when given.
 * @param query.pageSize - 1–100.
 * @param query.cursor - Where the previous page ended.
 * @returns The page.
 */
export async function applicationPage(query: {
  status?: PromoterApplicationStatus;
  pageSize: number;
  cursor?: string;
}): Promise<CreditPage<object>> {
  const rows = await listApplications({ status: query.status, limit: query.pageSize + 1, after: after(query.cursor) });
  return toPage(
    rows,
    query.pageSize,
    ({ cursorAt: _cursorAt, ...row }) => ({ ...row, createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null }),
    (row) => ({ cursorAt: row.cursorAt, id: row.id }),
  );
}

/**
 * One application with what the reviewer needs.
 * @param applicationId - The application.
 * @returns 200 with it, or 404.
 */
export async function application(applicationId: string): Promise<Answer> {
  const found: ApplicationDetail | null = await findApplicationDetail(applicationId);
  if (found === null) return NOT_FOUND;
  return {
    status: 200,
    body: {
      ...found,
      termsAcceptedAt: found.termsAcceptedAt.toISOString(),
      decidedAt: found.decidedAt?.toISOString() ?? null,
      createdAt: found.createdAt.toISOString(),
    },
  };
}

/**
 * A page of referral codes with how many accounts each carries.
 * @param query - Filter, page size and cursor.
 * @param query.status - Only this status, when given.
 * @param query.pageSize - 1–100.
 * @param query.cursor - Where the previous page ended.
 * @returns The page.
 */
export async function codePage(query: { status?: ReferralCodeStatus; pageSize: number; cursor?: string }): Promise<CreditPage<object>> {
  const rows = await listCodes({ status: query.status, limit: query.pageSize + 1, after: after(query.cursor) });
  return toPage(
    rows,
    query.pageSize,
    ({ cursorAt: _cursorAt, ...row }) => ({ ...row, createdAt: row.createdAt.toISOString(), removedAt: row.removedAt?.toISOString() ?? null }),
    (row) => ({ cursorAt: row.cursorAt, id: row.id }),
  );
}
