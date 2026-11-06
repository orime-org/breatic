// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation pins and `derived` reclaim registration (inner#1306 frames-split design §7.15).
 *
 * A derived presentation object (a ledger L(t), a carrier, a manifest, a chunk, stitch or prepared output) is alive
 * exactly while a live pin references it. `acquire` (Acq) adds a holder's references, `select` (Acq/Mv) keeps the one
 * `selected` row of a canonical key on the chosen version, `release` (Rel) soft-deletes a holder's rows. Every key that
 * loses its last live reference is queued as a `derived` reclaim row in the same transaction; the offline job checks
 * the pins again before deleting (§7.15 arbitration). The P descriptor pointer and the canonical object itself are never pinned
 * or registered.
 */

import { db, type DbTx } from "@breatic/core";
import { videoPresentationWorkKeyFor, videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor, type VideoPresentationPrepareAnswer } from "@breatic/shared";
import * as reclaimRepo from "@domain/asset/storage-reclaim.repo.js";
import * as pinRepo from "@domain/presentation/presentation-pin.repo.js";

/** The holders that pin per holder and toolInputId (the `selected` row has its own entry). */
export type PresentationPinHolder = Exclude<pinRepo.PresentationPinHolderKind, "selected">;

/** The fixed descriptor pointer's suffix: it follows the canonical object and is never a derived object (§7.15). */
const DESCRIPTOR_SUFFIX = ".video-presentation.v1.json";

/**
 * Run in the caller's transaction, or in a new one.
 * @param tx - The caller's transaction, if any.
 * @param work - The work.
 * @returns Its result.
 * @throws {Error} When the work fails.
 */
function within<T>(tx: DbTx | undefined, work: (tx: DbTx) => Promise<T>): Promise<T> {
  return tx === undefined ? db.transaction(work) : work(tx);
}

/**
 * The distinct derived keys among these, without the descriptor pointer or the canonical object.
 * @param keys - Candidate keys.
 * @param canonicalKey - The canonical object, when known.
 * @returns The keys a pin may reference.
 * @throws {never} Never.
 */
function derivedKeys(keys: readonly string[], canonicalKey?: string): string[] {
  return [...new Set(keys)].filter((key) => key.length > 0 && key !== canonicalKey && !key.endsWith(DESCRIPTOR_SUFFIX));
}

/**
 * Queue the keys no live pin references (offline reclaim's `derived` rows).
 * @param keys - Keys that were released or never pinned.
 * @param tx - The owning transaction.
 * @returns Nothing.
 * @throws {Error} When the read or insert fails.
 */
async function registerUnpinned(keys: readonly string[], tx: DbTx): Promise<void> {
  const candidates = derivedKeys(keys);
  const pinned = await pinRepo.pinnedKeys(candidates, tx);
  await reclaimRepo.queueDerived(candidates.filter((key) => !pinned.has(key)), tx);
}

/**
 * Acq: pin keys for a holder and toolInputId; repeating it adds new keys to the same live row.
 * @param pin - The holder and what it references.
 * @param pin.holderKind - The holder's kind.
 * @param pin.holderId - The task or presentation job.
 * @param pin.toolInputId - The toolInputId.
 * @param pin.preparedKey - The prepared model input of a `prepared` pin.
 * @param pin.objectKeys - The keys it references.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function acquire(pin: { holderKind: PresentationPinHolder; holderId: string; toolInputId: string; preparedKey?: string; objectKeys: readonly string[] }, tx?: DbTx): Promise<void> {
  await within(tx, async (tx) => {
    await pinRepo.lockHolder(pin.holderKind, pin.holderId, tx);
    const live = (await pinRepo.findLive(pin.holderKind, pin.holderId, tx))
      .find((row) => row.toolInputId === pin.toolInputId && row.preparedKey === (pin.preparedKey ?? null));
    const id = live?.id ?? await pinRepo.insertPin({ holderKind: pin.holderKind, holderId: pin.holderId, toolInputId: pin.toolInputId, preparedKey: pin.preparedKey ?? null }, tx);
    await pinRepo.addObjects(id, derivedKeys(pin.objectKeys), tx);
  });
}

/**
 * Make a holder's one live row of a toolInputId reference exactly these keys; keys it no longer references are registered.
 * @param holderKind - The holder's kind.
 * @param holderId - The holder.
 * @param fields - The row's toolInputId and version.
 * @param fields.toolInputId - The toolInputId.
 * @param fields.versionId - The selected version, for the `selected` row.
 * @param keys - Exactly the keys it references.
 * @param tx - The owning transaction.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
async function pinExactly(holderKind: pinRepo.PresentationPinHolderKind, holderId: string, fields: { toolInputId: string; versionId?: string }, keys: readonly string[], tx: DbTx): Promise<void> {
  await pinRepo.lockHolder(holderKind, holderId, tx);
  const live = await pinRepo.findLive(holderKind, holderId, tx);
  const current = live.length === 1 ? live[0]! : null;
  const wanted = new Set(keys);
  if (current !== null && current.toolInputId === fields.toolInputId && current.versionId === (fields.versionId ?? null) && current.keys.every((key) => wanted.has(key))) {
    // Only additions: the row keeps referencing what it did.
    await pinRepo.addObjects(current.id, keys.filter((key) => !current.keys.includes(key)), tx);
    return;
  }
  // The keys are append-only, so a row that drops a reference is replaced by a new one.
  await pinRepo.softDelete(live.map((row) => row.id), tx);
  const id = await pinRepo.insertPin({ holderKind, holderId, toolInputId: fields.toolInputId, versionId: fields.versionId ?? null }, tx);
  await pinRepo.addObjects(id, keys, tx);
  await registerUnpinned(live.flatMap((row) => row.keys).filter((key) => !wanted.has(key)), tx);
}

/**
 * Acq or Mv the canonical key's one `selected` row onto a version and exactly its objects.
 * @param pin - The canonical key, the selected version and its objects.
 * @param pin.canonicalKey - The canonical key.
 * @param pin.toolInputId - The selected version's toolInputId.
 * @param pin.versionId - The selected version.
 * @param pin.objectKeys - L of that toolInputId and the version's carrier and manifest.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function select(pin: { canonicalKey: string; toolInputId: string; versionId: string; objectKeys: readonly string[] }, tx?: DbTx): Promise<void> {
  await within(tx, (tx) => pinExactly("selected", pin.canonicalKey, { toolInputId: pin.toolInputId, versionId: pin.versionId }, derivedKeys(pin.objectKeys, pin.canonicalKey), tx));
}

/**
 * Rel: release every live row of one holder kind and holder, registering what nothing else references.
 * @param holder - The holder.
 * @param holder.holderKind - Its kind.
 * @param holder.holderId - The holder.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function release(holder: { holderKind: PresentationPinHolder; holderId: string }, tx?: DbTx): Promise<void> {
  await within(tx, async (tx) => {
    await pinRepo.lockHolder(holder.holderKind, holder.holderId, tx);
    const live = await pinRepo.findLive(holder.holderKind, holder.holderId, tx);
    await pinRepo.softDelete(live.map((row) => row.id), tx);
    await registerUnpinned(live.flatMap((row) => row.keys), tx);
  });
}

/**
 * Chk: whether a live pin references the key.
 * @param storageKey - The key.
 * @param tx - The caller's transaction, if any.
 * @returns Whether it is pinned.
 * @throws {Error} When the read fails.
 */
export async function isKeyPinned(storageKey: string, tx?: DbTx): Promise<boolean> {
  return (await pinRepo.pinnedKeys([storageKey], tx)).has(storageKey);
}

/**
 * The prepared inputs a run's live `prepared` pins keep.
 * @param holderId - The run.
 * @param tx - The caller's transaction.
 * @returns Each prepared key with its toolInputId.
 * @throws {Error} When the read fails.
 */
export async function heldPrepared(holderId: string, tx: DbTx): Promise<{ toolInputId: string; preparedKey: string }[]> {
  return (await pinRepo.findLive("prepared", holderId, tx)).flatMap((row) => row.preparedKey === null ? [] : [{ toolInputId: row.toolInputId, preparedKey: row.preparedKey }]);
}

/**
 * Every object a run's live `execution` pins keep.
 * @param holderId - The run.
 * @param tx - The caller's transaction.
 * @returns The keys.
 * @throws {Error} When the read fails.
 */
export async function heldExecutionObjects(holderId: string, tx: DbTx): Promise<string[]> {
  return (await pinRepo.findLive("execution", holderId, tx)).flatMap((row) => row.keys);
}

/**
 * Register outputs nothing will use (a failed attempt's, chunks after their stitch) unless a live pin references them.
 * @param keys - The keys.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function retire(keys: readonly string[], tx?: DbTx): Promise<void> {
  await within(tx, (tx) => registerUnpinned(keys, tx));
}

/**
 * The full and compact ledger keys of one toolInputId.
 * @param sourceKey - The canonical key.
 * @param toolInputId - The toolInputId.
 * @returns Both keys.
 * @throws {never} Never.
 */
export function ledgerObjectKeys(sourceKey: string, toolInputId: string): string[] {
  return [videoSourceLedgerKeyFor(sourceKey, toolInputId), videoSourceLedgerTableKeyFor(sourceKey, toolInputId)];
}

/**
 * The candidate's referenced work objects and the outputs it no longer needs, from the DO's units.
 * @param answer - The prepare answer.
 * @param jobId - The presentation job.
 * @returns What the candidate references and what to retire.
 * @throws {never} Never.
 */
function candidateWork(answer: VideoPresentationPrepareAnswer, jobId: string): { keep: string[]; retire: string[] } {
  const source = answer.sourceBinding.storageKey;
  const stitched = answer.units[`video-presentation:${jobId}:stitch`]?.state === "done";
  const keep: string[] = []; const retired: string[] = [];
  for (const [key, unit] of Object.entries(answer.units)) {
    // Chunk outputs are released once the stitch is committed (§7.15 release points).
    const chunk = key.startsWith(`video-presentation:${jobId}:chunk:`);
    for (const attempt of unit.attempts) {
      const output = videoPresentationWorkKeyFor(source, attempt.jobId);
      if (attempt.state === "failed" || (chunk && stitched)) retired.push(output); else keep.push(output);
    }
    if (unit.state === "done") keep.push(...(unit.receipts ?? []).map((receipt) => receipt.storageKey));
  }
  return { keep, retire: retired };
}

/**
 * Follow the DO's prepare answer for one presentation job (§7.15 candidate and selected rows; §90 E4-3): the selected
 * version's row, the job's candidate row while it is granted and unpublished, and the release of everything the
 * candidate no longer needs. Called once per worker pickup; the same answer twice changes nothing.
 * @param jobId - The presentation job.
 * @param answer - The DO's prepare answer.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function syncPresentationPins(jobId: string, answer: VideoPresentationPrepareAnswer): Promise<void> {
  const source = answer.sourceBinding.storageKey;
  await db.transaction(async (tx) => {
    const selected = answer.presentation;
    if (selected !== null) {
      const playback = selected.playback;
      const objects = [...ledgerObjectKeys(source, selected.toolInputId), playback.carrier.storageKey, ...(playback.kind === "alpha-packed" ? [playback.manifest.storageKey] : [])];
      await select({ canonicalKey: source, toolInputId: selected.toolInputId, versionId: selected.versionId, objectKeys: objects }, tx);
    }
    const plan = answer.plan;
    // No longer granted (archived, failed, past D) or published: the selected row has taken over what it needs.
    if (answer.capability === null || plan === null || selected?.toolInputId === plan.toolInputId) {
      await release({ holderKind: "candidate", holderId: jobId }, tx);
      return;
    }
    const work = candidateWork(answer, jobId);
    await pinExactly("candidate", jobId, { toolInputId: plan.toolInputId }, derivedKeys([...ledgerObjectKeys(source, plan.toolInputId), ...work.keep], source), tx);
    await registerUnpinned(work.retire, tx);
  });
}
