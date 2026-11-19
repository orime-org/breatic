// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Presentation pins and `derived` reclaim registration (inner#1306 frames-split design §7.15).
 *
 * A derived object (a playback file, a manifest, an edit file, a chunk, a stitch, a prepared input, a run's or an
 * analysis's intermediate) is alive exactly while a live pin references it. `acquire` (Acq) takes a holder's row, `add`
 * (Add) appends keys to it, `select` (Acq/Mv) keeps the one `selected` row of a canonical key on the chosen version and
 * replaces its object set in place, `retire` (Drop) removes a stitch's chunks from the holder that recorded it, and
 * `release` (Rel) soft-deletes a holder's rows. Every key that loses its last live reference is queued as a `derived`
 * reclaim row in the same transaction, with its canonical key when it is presentation-derived; the offline job checks the
 * pins and the current descriptor again before deleting (§7.15 arbitration). The P descriptor pointer and the canonical
 * object itself are never pinned or registered.
 */

import { db, type DbTx } from "@breatic/core";
import { videoPresentationWorkKeyFor, type VideoPresentationPrepareAnswer, type VideoPresentationVersion } from "@breatic/shared";
import * as reclaimRepo from "@domain/asset/storage-reclaim.repo.js";
import * as pinRepo from "@domain/presentation/presentation-pin.repo.js";

/** The holders that pin per holder (the `selected` row has its own entry). */
export type PresentationPinHolder = Exclude<pinRepo.PresentationPinHolderKind, "selected">;
/** One holder of the kinds `Add` and `Drop` act on. */
export type PresentationPinAppendHolder = { holderKind: "execution" | "analysis" | "candidate"; holderId: string };

/** The fixed descriptor pointer's suffix: it follows the canonical object and is never a derived object (§7.15). */
const DESCRIPTOR_SUFFIX = ".video-presentation.v1.json";
/** Where a presentation job's work key starts after its canonical key (`videoPresentationWorkKeyFor`). */
const PRESENTATION_WORK_MARK = ".video-presentation:";

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
 * The canonical key of a presentation job's work object: the prefix its work key is written under, or null for a key
 * that names none.
 * @param key - The object key.
 * @returns The canonical key, or null.
 * @throws {never} Never.
 */
function presentationCanonicalOf(key: string): string | null {
  const at = key.indexOf(PRESENTATION_WORK_MARK);
  return at > 0 ? key.slice(0, at) : null;
}

/**
 * Queue the keys no live pin references (offline reclaim's `derived` rows), each with its canonical key or null.
 * @param keys - Keys that were released or never pinned.
 * @param canonicalOf - A key's canonical key: the presentation-derived object's, null for a run's or an analysis's intermediate.
 * @param tx - The owning transaction.
 * @returns Nothing.
 * @throws {Error} When the read or insert fails.
 */
async function registerUnpinned(keys: readonly string[], canonicalOf: (key: string) => string | null, tx: DbTx): Promise<void> {
  const candidates = derivedKeys(keys);
  const pinned = await pinRepo.pinnedKeys(candidates, tx);
  await reclaimRepo.queueDerived(candidates.filter((key) => !pinned.has(key)).map((key) => ({ storageKey: key, canonicalKey: canonicalOf(key) })), tx);
}

/**
 * How a holder's released keys find their canonical key (§7.15 reclaim queue row): a presentation-derived object (a work key
 * of a presentation job, which a run's or an analysis's edit file also is) maps to its canonical key, an intermediate to null.
 * @param holderKind - The holder's kind.
 * @param canonicalKey - The canonical key, when the caller knows it.
 * @returns The mapping.
 * @throws {never} Never.
 */
function canonicalFor(holderKind: pinRepo.PresentationPinHolderKind, canonicalKey?: string): (key: string) => string | null {
  const own = holderKind === "candidate" || holderKind === "selected" ? canonicalKey : undefined;
  return (key) => own ?? presentationCanonicalOf(key);
}

/**
 * Acq: pin keys for a holder. A candidate is keyed by its presentation job alone and records its toolInputId once it is
 * known; the other holders hold one row per toolInputId (and a prepared row per prepared key). Repeating it adds new keys
 * to the same live row.
 * @param pin - The holder and what it references.
 * @param pin.holderKind - The holder's kind.
 * @param pin.holderId - The task or presentation job.
 * @param pin.toolInputId - The toolInputId; null only for a candidate that does not know it yet.
 * @param pin.preparedKey - The prepared model input of a `prepared` pin.
 * @param pin.objectKeys - The keys it references.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When a non-candidate pin names no toolInputId, or persistence fails.
 */
export async function acquire(pin: { holderKind: PresentationPinHolder; holderId: string; toolInputId: string | null; preparedKey?: string; objectKeys: readonly string[] }, tx?: DbTx): Promise<void> {
  if (pin.holderKind !== "candidate" && pin.toolInputId === null) throw new Error(`A ${pin.holderKind} pin records its toolInputId`);
  await within(tx, async (tx) => {
    await pinRepo.lockHolder(pin.holderKind, pin.holderId, tx);
    const live = await pinRepo.findLive(pin.holderKind, pin.holderId, tx);
    const row = pin.holderKind === "candidate" ? live[0] : live.find((candidate) => candidate.toolInputId === pin.toolInputId && candidate.preparedKey === (pin.preparedKey ?? null));
    let id: string;
    if (row === undefined) id = await pinRepo.insertPin({ holderKind: pin.holderKind, holderId: pin.holderId, toolInputId: pin.toolInputId, preparedKey: pin.preparedKey ?? null }, tx);
    else {
      id = row.id;
      if (pin.toolInputId !== null && row.toolInputId !== pin.toolInputId) await pinRepo.updatePin(id, { toolInputId: pin.toolInputId }, tx);
    }
    await pinRepo.addObjects(id, derivedKeys(pin.objectKeys), tx);
  });
}

/**
 * Add: append keys to a holder's existing live row, in the transaction that records them (§7.15 钉住行).
 * @param holder - The holder.
 * @param keys - The keys.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When the holder has no live row, or persistence fails.
 */
export async function add(holder: PresentationPinAppendHolder, keys: readonly string[], tx?: DbTx): Promise<void> {
  await within(tx, (tx) => pinRepo.appendPinObjects(holder.holderKind, holder.holderId, derivedKeys(keys), tx));
}

/**
 * Acq or Mv the canonical key's one `selected` row onto a version, in place: its toolInputId and versionId are updated and
 * its object set is replaced as a whole; an object only the old bundle held is registered with its canonical key, one both
 * bundles share is never released.
 * @param pin - The canonical key, the selected version and its objects.
 * @param pin.canonicalKey - The canonical key.
 * @param pin.toolInputId - The selected version's toolInputId.
 * @param pin.versionId - The selected version.
 * @param pin.objectKeys - The version's playback file, manifest and edit file.
 * @param tx - The caller's transaction, if any.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function select(pin: { canonicalKey: string; toolInputId: string; versionId: string; objectKeys: readonly string[] }, tx?: DbTx): Promise<void> {
  await within(tx, async (tx) => {
    const wanted = derivedKeys(pin.objectKeys, pin.canonicalKey);
    await pinRepo.lockHolder("selected", pin.canonicalKey, tx);
    const current = (await pinRepo.findLive("selected", pin.canonicalKey, tx))[0];
    if (current === undefined) {
      const id = await pinRepo.insertPin({ holderKind: "selected", holderId: pin.canonicalKey, toolInputId: pin.toolInputId, versionId: pin.versionId }, tx);
      await pinRepo.addObjects(id, wanted, tx);
      return;
    }
    if (current.toolInputId !== pin.toolInputId || current.versionId !== pin.versionId) await pinRepo.updatePin(current.id, { toolInputId: pin.toolInputId, versionId: pin.versionId }, tx);
    const dropped = current.keys.filter((key) => !wanted.includes(key));
    await pinRepo.removeObjects(current.id, dropped, tx);
    await pinRepo.addObjects(current.id, wanted.filter((key) => !current.keys.includes(key)), tx);
    await registerUnpinned(dropped, () => pin.canonicalKey, tx);
  });
}

/**
 * Rel: release every live row of one holder kind and holder, registering what nothing else references.
 * @param holder - The holder.
 * @param holder.holderKind - Its kind.
 * @param holder.holderId - The holder.
 * @param tx - The caller's transaction, if any.
 * @param canonicalKey - A candidate's canonical key, when the caller knows it.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function release(holder: { holderKind: PresentationPinHolder; holderId: string }, tx?: DbTx, canonicalKey?: string): Promise<void> {
  await within(tx, async (tx) => {
    await pinRepo.lockHolder(holder.holderKind, holder.holderId, tx);
    const live = await pinRepo.findLive(holder.holderKind, holder.holderId, tx);
    await pinRepo.softDelete(live.map((row) => row.id), tx);
    await registerUnpinned(live.flatMap((row) => row.keys), canonicalFor(holder.holderKind, canonicalKey), tx);
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
  return (await pinRepo.findLive("prepared", holderId, tx)).flatMap((row) => row.preparedKey === null || row.toolInputId === null ? [] : [{ toolInputId: row.toolInputId, preparedKey: row.preparedKey }]);
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
 * Drop (and a failed attempt's outputs): the holder's live rows stop referencing these keys, in place, in the transaction
 * that records the stitch or the failure (§7.15 Drop column); each key no other live pin references is registered. A
 * repeated Drop changes nothing.
 * @param holder - The run, analysis or presentation candidate that recorded the result.
 * @param keys - The keys.
 * @param tx - The caller's transaction.
 * @param canonicalKey - A candidate's canonical key, when the caller knows it.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function retire(holder: PresentationPinAppendHolder, keys: readonly string[], tx: DbTx, canonicalKey?: string): Promise<void> {
  const dropped = new Set(keys);
  await pinRepo.lockHolder(holder.holderKind, holder.holderId, tx);
  for (const row of await pinRepo.findLive(holder.holderKind, holder.holderId, tx)) {
    await pinRepo.removeObjects(row.id, row.keys.filter((key) => dropped.has(key)), tx);
  }
  await registerUnpinned(keys, canonicalFor(holder.holderKind, canonicalKey), tx);
}

/**
 * The objects a selected version's bundle holds (§7.15 selected row): its playback file, its manifest and its edit file.
 * @param version - The version.
 * @returns The keys.
 * @throws {never} Never.
 */
export function versionObjectKeys(version: VideoPresentationVersion): string[] {
  const { playback, toolSource } = version;
  return [playback.carrier.storageKey, ...(playback.kind === "alpha-packed" ? [playback.manifest.storageKey] : []), ...(toolSource.edit === null ? [] : [toolSource.edit.storageKey])];
}

/**
 * The candidate's referenced work objects and the outputs it no longer needs, from the DO's units: a failed attempt's
 * output is retired; a playback chunk is dropped once the playback stitch is done and an edit chunk once the edit stitch
 * is done (§7.15 Drop; the DO has taken the stitch's result before it reports the unit done).
 * @param answer - The prepare answer.
 * @param jobId - The presentation job.
 * @returns What the candidate references and what to retire.
 * @throws {never} Never.
 */
function candidateWork(answer: VideoPresentationPrepareAnswer, jobId: string): { keep: string[]; retire: string[] } {
  const source = answer.sourceBinding.storageKey;
  const prefix = `video-presentation:${jobId}:`;
  const stitched = answer.units[`${prefix}stitch`]?.state === "done";
  const editStitched = answer.units[`${prefix}edit-stitch`]?.state === "done";
  const keep: string[] = []; const retired: string[] = [];
  for (const [key, unit] of Object.entries(answer.units)) {
    const dropped = (key.startsWith(`${prefix}chunk:`) && stitched) || (key.startsWith(`${prefix}edit:`) && editStitched);
    for (const attempt of unit.attempts) {
      const output = videoPresentationWorkKeyFor(source, attempt.jobId);
      if (attempt.state === "failed" || dropped) retired.push(output); else keep.push(output);
    }
    if (unit.state === "done") keep.push(...(unit.receipts ?? []).map((receipt) => receipt.storageKey));
  }
  return { keep, retire: retired };
}

/**
 * Follow the DO's prepare answer for one presentation job (§7.15 candidate and selected rows): the selected version's row
 * (`Mv`, idempotent by versionId), the job's candidate row while it is granted and unpublished with its objects added and
 * its stitched chunks dropped, and the release of the candidate once it is published or over. Called once per worker
 * pickup; the same answer twice changes nothing.
 * @param jobId - The presentation job.
 * @param answer - The DO's prepare answer.
 * @returns Nothing.
 * @throws {Error} When persistence fails.
 */
export async function syncPresentationPins(jobId: string, answer: VideoPresentationPrepareAnswer): Promise<void> {
  const source = answer.sourceBinding.storageKey;
  await db.transaction(async (tx) => {
    const selected = answer.presentation;
    if (selected !== null) await select({ canonicalKey: source, toolInputId: selected.toolInputId, versionId: selected.versionId, objectKeys: versionObjectKeys(selected) }, tx);
    const plan = answer.plan;
    // No longer granted (archived, failed, past D) or published: the selected row has taken over what it needs.
    if (answer.capability === null || plan === null || (plan.toolInputId !== null && selected?.toolInputId === plan.toolInputId)) {
      await release({ holderKind: "candidate", holderId: jobId }, tx, source);
      return;
    }
    const work = candidateWork(answer, jobId);
    await acquire({ holderKind: "candidate", holderId: jobId, toolInputId: plan.toolInputId, objectKeys: derivedKeys(work.keep, source) }, tx);
    await retire({ holderKind: "candidate", holderId: jobId }, work.retire, tx, source);
  });
}
