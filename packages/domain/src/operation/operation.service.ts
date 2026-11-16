// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Monthly operations (inner#1968, design 3.2 to 3.4): admitting an
 * operation before it starts, counting it in the commit that records its
 * success, releasing it when it fails, deferring derived uploads and
 * sweeping the ones nothing used.
 *
 * Every decision on one account runs under its `users` row lock
 * (`lockOperationAccount`), taken before any ledger row, charge request or
 * hold; an admission past the allowance additionally takes the studio's debt
 * lock to hold `overage_credits`. With payments off, or for an account on the
 * `self_hosted` tier, nothing is metered and no row is written.
 */

import {
  db,
  env,
  getMembershipReadingForStudio,
  getMembershipReadingForUser,
  getNodeTaskConfig,
  getOperationsConfig,
  getStorageAdapter,
  lockOperationAccount,
  reportGraceMs,
} from "@breatic/core";
import type { DbTx, MembershipReading } from "@breatic/core";
import { quantizeQuotedCredits, serializeCreditMicro, type OperationUsage, type ProjectCreditsView } from "@breatic/shared";
import * as operationRepo from "@domain/operation/operation.repo.js";
import type { OperationKind, OperationRow } from "@domain/operation/operation.repo.js";
import { emitOperationAudit, type OperationAudit } from "@domain/operation/operation-events.js";
import { findLiveByKeyInStudio } from "@domain/asset/asset.repo.js";
import { resolveOwnerStudioId } from "@domain/asset/asset.service.js";
import * as creditHoldRepo from "@domain/credit/creditHold.repo.js";
import { lockedPosition } from "@domain/credit/creditHold.service.js";
import * as creditLotService from "@domain/credit/creditLot.service.js";
import { fromMicroCredits, serializeCreditPosition, toChargeCredits, toChargeMicro } from "@domain/credit/credit-math.js";

export type { OperationKind } from "@domain/operation/operation.repo.js";
export { onOperationAudit, type OperationAudit } from "@domain/operation/operation-events.js";

/** One operation to admit. */
export interface AdmitInput {
  kind: OperationKind;
  /** Its ledger key (design 3.2). */
  key: string;
  /** The project it runs in; absent only for a studio avatar, which names its studio. */
  projectId?: string;
  /** The studio, for a studio avatar only. */
  studioId?: string;
  /** Who starts it. */
  actorUserId: string;
  /** The public URLs of the media it uses, which may claim derived uploads. */
  inputs: readonly string[];
  /** Admit a released Agent message again under its key (design 3.3 step 3). */
  revive?: boolean;
}

/** What an admission came to (design 3.3). */
export type AdmitOutcome =
  | { kind: "not_metered" }
  | { kind: "covered" | "held"; studioId: string; accountUserId: string }
  | { kind: "taken"; status: OperationRow["status"] }
  | ({ kind: "refused"; studioId: string } & ProjectCreditsView);

/** What a count came to. */
export interface CountOutcome {
  slot: "allowance" | "overage";
  /** The overage charge request filed, to settle after the commit. */
  chargeRequestId: string | null;
}

/** Rolls an admission's savepoint back and carries its outcome out. */
class Rollback extends Error {
  /**
   * Carry an outcome out of the savepoint it rolls back.
   * @param outcome - What the admission came to.
   */
  constructor(readonly outcome: Extract<AdmitOutcome, { kind: "refused" | "taken" }>) {
    super("operation admission rolled back");
  }
}

/**
 * The hold an operation's own row still carries.
 * @param row - The row.
 * @returns Its hold key, or null.
 */
function ownHold(row: OperationRow): string | null {
  return row.admittedAs === "held" && !row.absorbedHoldReleased ? row.overageHold : null;
}

/**
 * How long an admitted operation stays in flight (design 3.1 `expires_at`).
 * @param kind - The operation kind.
 * @returns Milliseconds.
 */
function lifetimeMs(kind: OperationKind): number {
  if (kind === "chat_message") return getOperationsConfig().chat_message_lease_ms;
  if (kind === "upload" || kind === "url_paste") return getNodeTaskConfig().default_budget_ms;
  return getNodeTaskConfig().default_budget_ms + reportGraceMs();
}

/**
 * Lock the account a studio's allowance belongs to and read its membership
 * after the lock: the admin as of holding the lock decides (design 3.3 step 2).
 * @param studioId - The studio.
 * @param tx - The admission's transaction.
 * @returns The reading taken under the lock.
 */
async function lockStudioAccount(studioId: string, tx: DbTx): Promise<MembershipReading> {
  let admin = (await getMembershipReadingForStudio(studioId, tx)).subject.accountId;
  for (;;) {
    await lockOperationAccount(admin, tx);
    const reading = await getMembershipReadingForStudio(studioId, tx);
    if (reading.subject.accountId === admin) return reading;
    admin = reading.subject.accountId;
  }
}

/**
 * The live assets of a studio that the given URLs name, in input order, at
 * most `max_absorbed_per_operation` distinct.
 * @param studioId - The studio.
 * @param inputs - The URLs.
 * @param tx - The admission's transaction.
 * @returns Their asset ids.
 */
async function resolveInputs(studioId: string, inputs: readonly string[], tx: DbTx): Promise<string[]> {
  if (inputs.length === 0) return [];
  const max = getOperationsConfig().max_absorbed_per_operation;
  const storage = await getStorageAdapter();
  const ids: string[] = [];
  for (const url of inputs) {
    if (ids.length >= max) break;
    const key = storage.keyFromUrl(url);
    if (key === null) continue;
    const asset = await findLiveByKeyInStudio(studioId, key, tx);
    if (asset !== null && !ids.includes(asset.id)) ids.push(asset.id);
  }
  return ids;
}

/**
 * Admit one operation before it starts (design 3.3): not metered when
 * payments are off or the tier is `self_hosted`; `taken` when its key has a
 * row; otherwise its derived inputs are claimed, then it is `covered` while
 * the allowance has room for what is in flight, or `held` with
 * `overage_credits` held on its studio, or `refused` when the studio cannot
 * hold that much. A refusal rolls the claims back.
 * @param input - The operation.
 * @param tx - The entry's transaction, when the admission is its first statement.
 * @returns The outcome.
 * @throws {NotFoundError} When the project has no live studio.
 * @throws {Error} When the studio has no live admin, or the database fails.
 */
export async function admitOperation(input: AdmitInput, tx?: DbTx): Promise<AdmitOutcome> {
  if (!env.PAYMENT_ENABLED) return { kind: "not_metered" };
  const studioId = input.studioId ?? (await resolveOwnerStudioId(input.projectId!));
  const audits: OperationAudit[] = [];
  /**
   * The admission inside its own savepoint.
   * @param sp - The savepoint.
   * @returns The outcome.
   * @throws {Rollback} When it is refused or loses its key, rolling the claims back.
   */
  const run = async (sp: DbTx): Promise<AdmitOutcome> => {
    const reading = await lockStudioAccount(studioId, sp);
    if (!reading.operations.charging) return { kind: "not_metered" };
    const account = reading.subject.accountId;
    const existing = await operationRepo.findByKey(input.key, sp);
    if (existing !== null && !(input.revive === true && existing.status === "released")) return { kind: "taken", status: existing.status };

    const inputAssetIds = await resolveInputs(studioId, input.inputs, sp);
    for (const assetId of inputAssetIds) {
      const claimed = await operationRepo.claimOne({ studioId, accountUserId: account, assetId }, input.key, sp);
      if (claimed === null) continue;
      if (claimed.admittedAs === "held" && claimed.overageHold !== null) await creditHoldRepo.releaseHold(claimed.overageHold, sp);
      audits.push({ msg: "operation_derived_absorbed", userId: claimed.actorUserId, projectId: claimed.projectId, operationKey: claimed.operationKey, assetId: claimed.assetId, absorbedBy: input.key });
    }

    const { monthly, period } = reading.operations;
    const used = (await operationRepo.countInPeriod(account, period.start, sp)).allowance;
    const inFlight = await operationRepo.countCoveredInFlight(account, input.key, sp);
    const expiresAt = new Date(new Date(reading.asOf).getTime() + lifetimeMs(input.kind));
    let admittedAs: "covered" | "held" = "covered";
    let overageHold: string | null = null;
    if (inFlight >= Math.max(0, monthly - used)) {
      const amount = toChargeMicro(getOperationsConfig().overage_credits);
      const position = await lockedPosition(studioId, sp);
      if (position.available < amount) throw new Rollback({ kind: "refused", studioId, ...serializeCreditPosition(position) });
      admittedAs = "held";
      overageHold = `operation:${input.key}`;
      await creditHoldRepo.upsertHold({ studioId, actorUserId: input.actorUserId, referenceId: overageHold, amount: fromMicroCredits(amount), expiresAt }, sp);
    }
    const row = {
      operationKey: input.key, kind: input.kind, accountUserId: account, studioId, projectId: input.projectId ?? null,
      actorUserId: input.actorUserId, admittedAs, overageHold, expiresAt, inputAssetIds,
    };
    const written = existing === null ? await operationRepo.insertReserved(row, sp) : await operationRepo.reviveReleased(row, sp);
    // A concurrent admission of the same key won: nothing of this one stays.
    if (!written) throw new Rollback({ kind: "taken", status: "reserved" });
    return { kind: admittedAs, studioId, accountUserId: account };
  };
  try {
    const outcome = tx === undefined ? await db.transaction(run) : await tx.transaction(run);
    emitOperationAudit(audits);
    return outcome;
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    return err.outcome;
  }
}

/**
 * Count a row under its account lock: the slot follows what is counted at
 * this moment; past the allowance, while charging, one `operation_overage`
 * request takes the row's hold over, otherwise the hold is released. The
 * derived images among its inputs are used up in the same transaction.
 * @param found - The row.
 * @param from - The status it must still have.
 * @param tx - The success transaction.
 * @returns The outcome, or null when the compare-and-set missed.
 */
async function settleCount(found: OperationRow, from: "reserved" | "deferred", tx: DbTx): Promise<CountOutcome | null> {
  await lockOperationAccount(found.accountUserId, tx);
  const reading = await getMembershipReadingForUser(found.accountUserId, tx);
  const { monthly, period, charging } = reading.operations;
  const used = (await operationRepo.countInPeriod(found.accountUserId, period.start, tx)).allowance;
  const slot = used < monthly ? "allowance" : "overage";
  const counted = await operationRepo.markCounted(found.operationKey, from, { slot, periodStart: period.start, countedAt: new Date(reading.asOf) }, tx);
  if (counted === null) return null;
  const hold = ownHold(counted);
  let chargeRequestId: string | null = null;
  if (slot === "overage" && charging) {
    chargeRequestId = await creditLotService.requestCharge({
      kind: "operation_overage",
      referenceId: counted.operationKey,
      actorUserId: counted.actorUserId,
      projectId: counted.projectId,
      studioId: counted.studioId,
      amount: toChargeCredits(getOperationsConfig().overage_credits),
      description: "Operation overage",
      ...(hold === null ? {} : { releaseHold: hold }),
    }, tx);
    if (chargeRequestId !== null) await operationRepo.setChargeRequest(counted.operationKey, chargeRequestId, tx);
  } else if (hold !== null) {
    await creditHoldRepo.releaseHold(hold, tx);
  }
  for (const absorbed of await operationRepo.markAbsorbed(counted, tx)) {
    if (absorbed.admittedAs === "held" && absorbed.overageHold !== null) await creditHoldRepo.releaseHold(absorbed.overageHold, tx);
  }
  return { slot, chargeRequestId };
}

/**
 * Count an admitted operation in the transaction that records its success
 * (design 3.4). An operation never admitted, or already counted, released or
 * deferred, is left alone.
 * @param key - Its key.
 * @param tx - The success transaction.
 * @returns The outcome, or null when nothing was counted.
 * @throws {Error} When the database fails; the success rolls back with it.
 */
export async function countOperation(key: string, tx: DbTx): Promise<CountOutcome | null> {
  const found = await operationRepo.findByKey(key, tx);
  if (found === null || found.status !== "reserved") return null;
  return settleCount(found, "reserved", tx);
}

/**
 * Settle an overage charge a count filed, after its commit. A failure is
 * recorded on the request by `settleCharge` and retried by the worker's
 * `credit-charge-sweep`, so the success it follows is not failed by it.
 * @param outcome - What the count came to.
 * @returns Resolves when settled or left for the sweep.
 */
export async function settleOverage(outcome: CountOutcome | null): Promise<void> {
  if (!outcome?.chargeRequestId) return;
  await creditLotService.settleCharge(outcome.chargeRequestId).catch(() => null);
}

/** What an upload declared about where it lands. */
export interface UploadPlacement {
  derived: boolean | null;
  spaceId: string | null;
  nodeId: string | null;
  /** The upload's purpose, as its grant records it (`project_cover`, `studio_avatar`). */
  assetSource: string | null;
  source: string | null;
}

/**
 * Whether an upload is a derived image whose count waits for an operation to
 * use it (design 3.2.1): declared derived, onto a Space, with no node,
 * purpose or source, and registered as an image from the stored bytes.
 * @param upload - What the upload declared.
 * @param assetKind - What the registered asset is.
 * @returns Whether to defer.
 */
export function defersCount(upload: UploadPlacement, assetKind: string): boolean {
  return upload.derived === true && assetKind === "image" && upload.spaceId !== null
    && upload.nodeId === null && upload.assetSource === null && upload.source === null;
}

/**
 * Defer a derived upload instead of counting it (design 3.2.1).
 * @param key - The upload's key.
 * @param assetId - The image it registered.
 * @param tx - The success transaction.
 * @returns Whether the row was deferred.
 * @throws {Error} When the database fails.
 */
export async function deferOperation(key: string, assetId: string, tx: DbTx): Promise<boolean> {
  const found = await operationRepo.findByKey(key, tx);
  if (found === null || found.status !== "reserved") return false;
  await lockOperationAccount(found.accountUserId, tx);
  const deferred = await operationRepo.markDeferred(key, assetId, tx);
  if (deferred === null) return false;
  emitOperationAudit([{ msg: "operation_deferred", userId: deferred.actorUserId, projectId: deferred.projectId, operationKey: key, assetId }]);
  return true;
}

/**
 * Record the asset a counted upload registered.
 * @param key - The upload's key.
 * @param assetId - The asset.
 * @param tx - The success transaction.
 */
export async function recordOperationAsset(key: string, assetId: string, tx: DbTx): Promise<void> {
  await operationRepo.setAsset(key, assetId, tx);
}

/**
 * Release an operation that failed or was withdrawn (design 3.2 release
 * points), with its hold, and give back the derived rows it claimed. A row
 * already counted, deferred or released is left alone.
 * @param key - Its key.
 * @param tx - The failure transaction; one is opened when absent.
 * @param reason - Why, kept on the row.
 * @returns Whether a row was released.
 * @throws {Error} When the database fails.
 */
export async function releaseOperation(key: string, tx?: DbTx, reason = "failed"): Promise<boolean> {
  /**
   * The release on one transaction.
   * @param t - The transaction.
   * @returns Whether a row was released.
   */
  const run = async (t: DbTx): Promise<boolean> => {
    const found = await operationRepo.findByKey(key, t);
    if (found === null || found.status !== "reserved") return false;
    await lockOperationAccount(found.accountUserId, t);
    const released = await operationRepo.markReleased(key, reason, t);
    if (released === null) return false;
    const hold = ownHold(released);
    if (hold !== null) await creditHoldRepo.releaseHold(hold, t);
    await operationRepo.unclaim(key, t);
    return true;
  };
  return tx === undefined ? db.transaction(run) : run(tx);
}

/**
 * Keep a waiting Agent message in flight, with its hold, for another lease,
 * once half of its lease has run.
 * @param key - Its key.
 * @returns Resolves when renewed; a row no longer reserved is left alone.
 * @throws {Error} When the database fails.
 */
export async function renewOperation(key: string): Promise<void> {
  const lease = getOperationsConfig().chat_message_lease_ms;
  const now = Date.now();
  const until = new Date(now + lease);
  if (await operationRepo.extend(key, until, new Date(now + lease / 2))) await creditHoldRepo.extendHold(`operation:${key}`, until);
}

/**
 * Keep an operation admitted for a task in flight, with its overage hold,
 * while the task waits for a free running slot (inner#1968): only a reserved
 * row expiring before `dueBefore` is written.
 * @param key - Its key.
 * @param until - The new expiry.
 * @param dueBefore - Renew only what expires before this moment.
 * @param tx - The gate's transaction.
 * @throws {Error} When the database fails.
 */
export async function extendInFlight(key: string, until: Date, dueBefore: Date, tx: DbTx): Promise<void> {
  if (await operationRepo.extend(key, until, dueBefore, tx)) await creditHoldRepo.extendHold(`operation:${key}`, until, tx);
}

/**
 * Count every derived upload no live operation claimed before it expired
 * (design 3.2.1), each in its own transaction under its account lock, in the
 * period of this moment; settle the overage charges this files.
 * @returns How many were counted.
 * @throws {Error} When the database fails; rows not reached stay for the next run.
 */
export async function sweepDeferredOperations(): Promise<number> {
  let total = 0;
  for (const due of await operationRepo.listSweepable(500)) {
    const outcome = await db.transaction(async (tx) => {
      const found = await operationRepo.findByKey(due.operationKey, tx);
      if (found === null || found.status !== "deferred") return null;
      return settleCount(found, "deferred", tx);
    });
    if (outcome === null) continue;
    total += 1;
    const row = await operationRepo.findByKey(due.operationKey);
    emitOperationAudit([{ msg: "operation_deferred_counted", userId: row!.actorUserId, projectId: row!.projectId, operationKey: due.operationKey, slot: outcome.slot }]);
    await settleOverage(outcome);
  }
  return total;
}

/**
 * Whether an operation key already has a row.
 * @param key - The key.
 * @returns Its status, or null.
 */
export async function operationStatus(key: string): Promise<OperationRow["status"] | null> {
  return (await operationRepo.findByKey(key))?.status ?? null;
}

/**
 * What one account has used of this period's operations, read under no lock:
 * one membership reading gives the allowance and the period, one aggregate
 * gives the counts. Counts are read even where nothing is metered.
 * @param userId - The account.
 * @param tx - Optional transaction handle.
 * @returns The usage, and whether operations are metered for the account.
 * @throws {Error} if no live account has that id, or its data is invalid.
 */
async function usageOf(userId: string, tx?: DbTx): Promise<{ usage: OperationUsage; charging: boolean }> {
  const { operations } = await getMembershipReadingForUser(userId, tx);
  const counts = await operationRepo.countInPeriod(userId, operations.period.start, tx);
  return {
    charging: operations.charging,
    usage: {
      monthlyAllowance: operations.monthly,
      usedThisPeriod: counts.allowance + counts.overage,
      allowanceUsed: counts.allowance,
      allowanceRemaining: Math.max(0, operations.monthly - counts.allowance),
      overageThisPeriod: counts.overage,
      periodStart: operations.period.start.toISOString(),
      nextResetAt: operations.period.end.toISOString(),
      overageCredits: serializeCreditMicro(quantizeQuotedCredits(getOperationsConfig().overage_credits)),
    },
  };
}

/**
 * What one account has used of this period's operations.
 * @param userId - The account.
 * @param tx - Optional transaction handle.
 * @returns The usage.
 * @throws {Error} if no live account has that id, or its data is invalid.
 */
export async function readOperationUsage(userId: string, tx?: DbTx): Promise<OperationUsage> {
  return (await usageOf(userId, tx)).usage;
}

/**
 * What one account has used of this period's operations, where they are
 * metered; what an account panel shows.
 * @param userId - The account.
 * @param tx - Optional transaction handle.
 * @returns The usage, or null where operations are not counted (payments off, or the self_hosted tier).
 * @throws {Error} if no live account has that id, or its data is invalid.
 */
export async function readMeteredOperationUsage(userId: string, tx?: DbTx): Promise<OperationUsage | null> {
  const { usage, charging } = await usageOf(userId, tx);
  return charging ? usage : null;
}
