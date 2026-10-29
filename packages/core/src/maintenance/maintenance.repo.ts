// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Single owner of maintenance persistence; callers compose transactions explicitly.
 */
import { and, desc, eq, isNull, lt, lte, sql } from "drizzle-orm";
import { db, type DbTx } from "@core/db/client.js";
import { storageReclaimPreviews as previews, storageReclaimOperations as operations, storageReclaimControls as controls, storageReclaimObjects as objects, storageReclaimRuns as runs, storageReclaimAttempts as attempts } from "@core/db/schema.js";
import type { ReclaimScope, ReclaimDecision, ReclaimControlDecision, ReclaimItemResult, ReclaimRun } from "@core/maintenance/types.js";

/**
 * Stable operation data; schema infer types never leave this repository.
 */
export interface MaintenanceOperation {
  id: string;
  key: string;
  fingerprint: string;
  decision: ReclaimDecision;
  scope: ReclaimScope[];
  state: string;
  version: number;
  changedBy: string;
  changedAt: Date;
  nextCheckAt: Date;
}

/**
 * One durable object, including the current holder's lease.
 */
export interface MaintenanceObject {
  id: string;
  storageKey: string;
  operationId: string;
  scope: ReclaimScope;
  retiredAt: Date | null;
  leaseVersion: number;
  leaseUntil: Date | null;
  inFlight: boolean;
  latest: ReclaimItemResult;
}

/**
 * Immutable preview binding.
 */
export interface MaintenancePreview {
  id: string;
  requestedBy: string;
  items: ReclaimScope[];
  expiresAt: Date;
}

/**
 * Independently idempotent control record.
 */
export interface MaintenanceControl {
  fingerprint: string;
  kind: string;
  decision: ReclaimControlDecision;
  operationId: string;
}

/**
 * Serialize all decisions about a physical key, even before any row exists.
 * @param key - Exact bucket key or operation/control namespace.
 * @param tx - Caller transaction retained through the protected decision.
 * @throws {Error} On database failure.
 */
export async function lockKey(key: string, tx: DbTx): Promise<void> {
  await tx.execute(sql `SELECT pg_advisory_xact_lock(hashtextextended(${key}, 1791))`);
}

/**
 * Read one approval by its immutable key.
 * @param key - Original acceptance key.
 * @param tx - Optional caller transaction.
 * @returns The durable approval or refusal.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function findOperation(key: string, tx?: DbTx): Promise<MaintenanceOperation | null> {
  const rows = await (tx ?? db).select().from(operations).where(and(eq(operations.key, key), isNull(operations.deletedAt))).limit(1);
  return rows[0] ?? null;
}

/**
 * Lock an operation by immutable identity before reading mutable switch/round state.
 * @param id - Operation UUID.
 * @param tx - Caller transaction.
 * @returns Current locked operation.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function lockOperation(id: string, tx: DbTx): Promise<MaintenanceOperation | null> {
  const rows = await tx.select().from(operations).where(and(eq(operations.id, id), isNull(operations.deletedAt))).for("update");
  return rows[0] ?? null;
}

/**
 * Persist an original immutable W.
 * @param value - Complete operation fields.
 * @param tx - Serialized transaction.
 * @returns Inserted operation.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function insertOperation(value: Omit<MaintenanceOperation, "id">, tx: DbTx): Promise<MaintenanceOperation> {
  return (await tx.insert(operations).values(value).returning())[0]!;
}

/**
 * Save a preview bound to the signed administrator.
 * @param value - Exact candidate scope and deadline.
 * @returns Persisted preview.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function createPreview(value: Omit<MaintenancePreview, "id">): Promise<MaintenancePreview> {
  return (await db.insert(previews).values(value).returning())[0]!;
}

/**
 * Read a preview by immutable identity.
 * @param id - Preview UUID.
 * @param tx - Optional caller transaction.
 * @returns Persisted preview or null.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function findPreview(id: string, tx?: DbTx): Promise<MaintenancePreview | null> {
  return (await (tx ?? db).select().from(previews).where(and(eq(previews.id, id), isNull(previews.deletedAt))).limit(1))[0] ?? null;
}

/**
 * Read the durable association and registration stop for one exact key.
 * @param key - Exact key.
 * @param tx - Optional caller transaction.
 * @returns Its durable approval association.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function findObject(key: string, tx?: DbTx): Promise<MaintenanceObject | null> {
  return (await (tx ?? db).select().from(objects).where(and(eq(objects.storageKey, key), isNull(objects.deletedAt))).limit(1))[0] ?? null;
}

/**
 * Link a scope for its full lifetime, never released by completion or pause.
 * @param operationId - Original approval.
 * @param scope - Owner-approved exact candidate.
 * @param tx - Transaction holding all scope key locks.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function addObject(operationId: string, scope: ReclaimScope, tx: DbTx): Promise<void> {
  await tx.insert(objects).values({
    operationId, storageKey: scope.storageKey, scope, latest: {
      id: scope.id, storageKey: scope.storageKey, state: "queued", reason: null, checkedAt: null, leaseVersion: 0
    }
  });
}

/**
 * Read approved objects in deterministic order.
 * @param operationId - Original approval.
 * @param tx - Optional caller transaction.
 * @returns Complete approved scope, including cleaned objects.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function listObjects(operationId: string, tx?: DbTx): Promise<MaintenanceObject[]> {
  return (tx ?? db).select().from(objects).where(and(eq(objects.operationId, operationId), isNull(objects.deletedAt))).orderBy(objects.storageKey);
}

/**
 * Update lease/registration stop or latest result under its key lock.
 * @param id - Immutable object UUID.
 * @param value - Mutable fields.
 * @param tx - Caller transaction.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function updateObject(id: string, value: Partial<Pick<MaintenanceObject, "retiredAt" | "leaseVersion" | "leaseUntil" | "inFlight" | "latest">>, tx: DbTx): Promise<void> {
  await tx.update(objects).set({
    ...value, updatedAt: new Date()
  }).where(eq(objects.id, id));
}

/**
 * List bounded due operations, including paused operations for HEAD recovery.
 * @param now - Scheduling instant.
 * @param limit - Work bound.
 * @returns Due accepted operations.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function listDue(now: Date, limit: number): Promise<MaintenanceOperation[]> {
  return db.select().from(operations).where(and(lte(operations.nextCheckAt, now), isNull(operations.deletedAt))).orderBy(operations.nextCheckAt, operations.id).limit(limit);
}

/**
 * Save mutable switch or scheduling fields without changing W.
 * @param id - Immutable operation identity.
 * @param value - Mutable fields.
 * @param tx - Locked transaction.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function updateOperation(id: string, value: Partial<Pick<MaintenanceOperation, "state" | "version" | "changedBy" | "changedAt" | "nextCheckAt">>, tx: DbTx): Promise<void> {
  await tx.update(operations).set({
    ...value, updatedAt: new Date()
  }).where(eq(operations.id, id));
}

/**
 * Read immutable control receipt.
 * @param key - Independent idempotency key.
 * @param tx - Optional transaction.
 * @returns Receipt or null.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function findControl(key: string, tx?: DbTx): Promise<MaintenanceControl | null> {
  return (await (tx ?? db).select().from(controls).where(and(eq(controls.key, key), isNull(controls.deletedAt))).limit(1))[0] ?? null;
}

/**
 * Save a control receipt atomically with its switch change.
 * @param value - Immutable receipt.
 * @param tx - Serialized transaction.
 */
export async function addControl(value: MaintenanceControl & {
  key: string;
}, tx: DbTx): Promise<void> {
  await tx.insert(controls).values(value);
}

/**
 * Read one bounded page of durable rounds by operation/number index.
 * @param operationId - Original approval.
 * @param limit - Strict page bound.
 * @param before - Exclusive round number from a validated cursor.
 * @returns Most recent first, including one extra row when requested.
 * @throws {Error} On database failure.
 */
export async function listRunPage(operationId: string, limit: number, before?: number): Promise<ReclaimRun[]> {
  const rows = await db.select({
    snapshot: runs.snapshot
  }).from(runs).where(and(eq(runs.operationId, operationId), isNull(runs.deletedAt), before === undefined ? undefined : lt(runs.number, before))).orderBy(desc(runs.number)).limit(limit);
  return rows.map(row => row.snapshot);
}

/**
 * Read one round by exact operation and immutable cursor identity.
 * @param operationId - Original approval.
 * @param id - Round UUID.
 * @param tx - Optional caller transaction.
 * @returns Exact round or null; other operations never resolve this cursor.
 * @throws {Error} On database failure.
 */
export async function findRun(operationId: string, id: string, tx?: DbTx): Promise<ReclaimRun | null> {
  return (await (tx ?? db).select({
    snapshot: runs.snapshot
  }).from(runs).where(and(eq(runs.operationId, operationId), eq(runs.id, id), isNull(runs.deletedAt))).limit(1))[0]?.snapshot ?? null;
}

/**
 * Read the initial execution independently of subsequent history.
 * @param operationId - Original approval.
 * @param tx - Optional caller transaction.
 * @returns Initial progress or null before the first claim.
 * @throws {Error} On database failure.
 */
export async function firstRun(operationId: string, tx?: DbTx): Promise<ReclaimRun | null> {
  return (await (tx ?? db).select({
    snapshot: runs.snapshot
  }).from(runs).where(and(eq(runs.operationId, operationId), eq(runs.number, 1), isNull(runs.deletedAt))).limit(1))[0]?.snapshot ?? null;
}

/**
 * Read the latest round with a bounded descending index lookup.
 * @param operationId - Original approval.
 * @param tx - Optional caller transaction.
 * @returns Latest round or null before the first claim.
 * @throws {Error} On database failure.
 */
export async function latestRun(operationId: string, tx?: DbTx): Promise<ReclaimRun | null> {
  return (await (tx ?? db).select({
    snapshot: runs.snapshot
  }).from(runs).where(and(eq(runs.operationId, operationId), isNull(runs.deletedAt))).orderBy(desc(runs.number)).limit(1))[0]?.snapshot ?? null;
}

/**
 * Insert a new traversal snapshot.
 * @param operationId - Original approval.
 * @param snapshot - First or recurring round.
 * @param tx - Operation-locked transaction.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function addRun(operationId: string, snapshot: ReclaimRun, tx: DbTx): Promise<void> {
  await tx.insert(runs).values({
    id: snapshot.id, operationId, number: snapshot.number, snapshot
  });
}

/**
 * Update current round snapshot while retaining earlier rounds.
 * @param snapshot - Current snapshot.
 * @param tx - Operation-locked transaction.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function saveRun(snapshot: ReclaimRun, tx: DbTx): Promise<void> {
  await tx.update(runs).set({
    snapshot, updatedAt: new Date()
  }).where(eq(runs.id, snapshot.id));
}

/**
 * Read an association's original operation by immutable UUID.
 * @param id - Operation UUID.
 * @returns Original operation or null.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function findOperationById(id: string): Promise<MaintenanceOperation | null> {
  return (await db.select().from(operations).where(and(eq(operations.id, id), isNull(operations.deletedAt))).limit(1))[0] ?? null;
}

/**
 * A physical response retained regardless of lease ownership.
 */
export interface MaintenanceAttempt {
  operationId: string;
  objectId: string;
  runId: string;
  leaseVersion: number;
  result: ReclaimItemResult;
}

/**
 * Append every physical reply even when its lease has already been replaced.
 * @param value - Exact attempt identity and returned result.
 * @param tx - Caller transaction.
 * @throws {Error} On an infrastructure failure; the current transaction rolls back.
 */
export async function addAttempt(value: MaintenanceAttempt, tx: DbTx): Promise<void> {
  await tx.insert(attempts).values(value);
}
