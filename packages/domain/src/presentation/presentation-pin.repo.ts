// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation pin repository (inner#1306 frames-split design §7.15): the only writer of `presentation_pins` and
 * `presentation_pin_objects`. A pin is live while `deleted_at` is null; its keys are appended when it is acquired and
 * never removed, so changing what a holder references soft-deletes its row and writes a new one.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, presentationPinObjects, presentationPins, type DbTx } from "@breatic/core";

/** The five holders of §7.15. */
export type PresentationPinHolderKind = "execution" | "analysis" | "prepared" | "candidate" | "selected";

/** One live pin and the keys it references. */
export interface LivePresentationPin {
  id: string;
  toolInputId: string;
  preparedKey: string | null;
  versionId: string | null;
  keys: string[];
}

/**
 * Serialize every pin write of one holder until the transaction ends.
 * @param holderKind - The holder's kind.
 * @param holderId - The holder.
 * @param tx - The owning transaction.
 * @returns Once the lock is held.
 * @throws {Error} When the lock statement fails.
 */
export async function lockHolder(holderKind: PresentationPinHolderKind, holderId: string, tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`presentation-pin:${holderKind}:${holderId}`}, 0))`);
}

/**
 * The live pins of one holder kind and holder, with their keys.
 * @param holderKind - The holder's kind.
 * @param holderId - The holder.
 * @param tx - The owning transaction.
 * @returns Its live pins.
 * @throws {Error} When the query fails.
 */
export async function findLive(holderKind: PresentationPinHolderKind, holderId: string, tx: DbTx): Promise<LivePresentationPin[]> {
  const rows = await tx.select({ id: presentationPins.id, toolInputId: presentationPins.toolInputId, preparedKey: presentationPins.preparedKey, versionId: presentationPins.versionId })
    .from(presentationPins)
    .where(and(eq(presentationPins.holderKind, holderKind), eq(presentationPins.holderId, holderId), isNull(presentationPins.deletedAt)));
  if (rows.length === 0) return [];
  const objects = await tx.select({ pinId: presentationPinObjects.pinId, storageKey: presentationPinObjects.storageKey })
    .from(presentationPinObjects).where(inArray(presentationPinObjects.pinId, rows.map((row) => row.id)));
  return rows.map((row) => ({ ...row, keys: objects.filter((object) => object.pinId === row.id).map((object) => object.storageKey) }));
}

/**
 * Insert a live pin.
 * @param pin - Its holder, toolInputId and optional prepared key or version.
 * @param pin.holderKind - The holder's kind.
 * @param pin.holderId - The holder.
 * @param pin.toolInputId - The toolInputId it pins.
 * @param pin.preparedKey - The prepared model input of a `prepared` pin.
 * @param pin.versionId - The selected version of a `selected` pin.
 * @param tx - The owning transaction.
 * @returns Its id.
 * @throws {Error} When the insert fails.
 */
export async function insertPin(pin: { holderKind: PresentationPinHolderKind; holderId: string; toolInputId: string; preparedKey?: string | null; versionId?: string | null }, tx: DbTx): Promise<string> {
  const [row] = await tx.insert(presentationPins).values({ holderKind: pin.holderKind, holderId: pin.holderId, toolInputId: pin.toolInputId,
    preparedKey: pin.preparedKey ?? null, versionId: pin.versionId ?? null }).returning({ id: presentationPins.id });
  return row!.id;
}

/**
 * Append the keys a pin references; a key already recorded is kept once.
 * @param pinId - The pin.
 * @param keys - The keys.
 * @param tx - The owning transaction.
 * @returns Nothing.
 * @throws {Error} When the insert fails.
 */
export async function addObjects(pinId: string, keys: readonly string[], tx: DbTx): Promise<void> {
  if (keys.length === 0) return;
  await tx.insert(presentationPinObjects).values(keys.map((storageKey) => ({ pinId, storageKey }))).onConflictDoNothing();
}

/**
 * Release pins: their rows stay, soft deleted.
 * @param ids - The pins.
 * @param tx - The owning transaction.
 * @returns Nothing.
 * @throws {Error} When the update fails.
 */
export async function softDelete(ids: readonly string[], tx: DbTx): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(presentationPins).set({ deletedAt: sql`now()` }).where(and(inArray(presentationPins.id, [...ids]), isNull(presentationPins.deletedAt)));
}

/**
 * Which of these keys a live pin references.
 * @param keys - The keys.
 * @param tx - The owning transaction, or none for a plain read.
 * @returns The referenced ones.
 * @throws {Error} When the query fails.
 */
export async function pinnedKeys(keys: readonly string[], tx?: DbTx): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await (tx ?? db).selectDistinct({ storageKey: presentationPinObjects.storageKey })
    .from(presentationPinObjects).innerJoin(presentationPins, eq(presentationPins.id, presentationPinObjects.pinId))
    .where(and(inArray(presentationPinObjects.storageKey, [...keys]), isNull(presentationPins.deletedAt)));
  return new Set(rows.map((row) => row.storageKey));
}

/**
 * Append keys to an execution's live pin inside the caller's registration transaction (§97 D17-7): the lip-sync
 * intermediates stay pinned with the run and are registered with the ledgers when that pin is released.
 * @param taskId - The execution's task.
 * @param keys - The keys.
 * @param tx - The registration transaction.
 * @returns Nothing.
 * @throws {Error} When the execution has no single live pin, or a write fails.
 */
export async function appendExecutionPinObjects(taskId: string, keys: readonly string[], tx: DbTx): Promise<void> {
  await appendPinObjects("execution", taskId, keys, tx);
}

/**
 * Append keys to a run's or an analysis's live pin inside the caller's transaction (frames-split §7.15; execution design
 * §10.3: a tracking analysis's clips and RLE stay pinned with the analysis until it ends). A run of two inputs holds one
 * row per input; the keys go to one of them, all of which are released together.
 * @param holderKind - The holder's kind.
 * @param holderId - The holder.
 * @param keys - The keys.
 * @param tx - The registration transaction.
 * @returns Nothing.
 * @throws {Error} When the holder has no live pin, or a write fails.
 */
export async function appendPinObjects(holderKind: "execution" | "analysis", holderId: string, keys: readonly string[], tx: DbTx): Promise<void> {
  if (keys.length === 0) return;
  await lockHolder(holderKind, holderId, tx);
  const live = await findLive(holderKind, holderId, tx);
  if (live.length === 0) throw new Error(`${holderKind} ${holderId} has no live pin to append to`);
  await addObjects(live[0]!.id, keys, tx);
}
