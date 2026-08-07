// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Per-document bookkeeping for "does this document hold content the database
 * has never accepted", and for "was this store started by us".
 *
 * The hocuspocus server package (4.5.0) answers neither question. `Document` carries a
 * `lastChangeTime`, but nothing records what the last successful store
 * covered, and the store hook cannot tell a timed store from the one the
 * library fires after every edit.
 *
 * WHY A COUNTER AND NOT A YJS STATE VECTOR. A vector cannot see a deletion:
 * Yjs records deletes in a delete set rather than advancing any client's
 * clock, so "delete a paragraph, the store fails, close the tab" reads as
 * "nothing outstanding" and the deletion is lost. Measured, not reasoned —
 * inner/engineering/demo/2026-08-06-unsaved-detection-and-final-retry-probe.mjs
 * demonstrates the loss with the vector and its absence with this counter.
 *
 * WHY NOT `lastChangeTime`. It is a wall clock: two changes inside the same
 * millisecond are indistinguishable, and a system clock adjustment can move
 * it backwards. A counter has neither problem.
 *
 * Every update counts, including one relayed from another instance. That is
 * deliberate: it is what makes a surviving instance store content on behalf
 * of one that died. See the design's §3.2.
 */

/** Updates each document has taken since collab loaded it. */
const changeCount = new Map<string, number>();

/** Update count that the last SUCCESSFUL store covered, per document. */
const storedCount = new Map<string, number>();

/** One attempt's permission, and what became of it. */
interface ArmRecord {
  /** Identifies the attempt, so only its issuer can take it back. */
  token: symbol;
  /** Whether the persistence extension actually ran for this attempt. */
  ran: boolean;
  /** What that extension's write did, once it knows. */
  outcome?: StoreOutcome;
}

/**
 * The one-shot permission each document currently carries, if any.
 *
 * It has an owner, because two writers can want to store the same document
 * (the timed round and the unload gate) and both give their permission back
 * when they stop waiting — an upstream extension can abort the hook chain
 * before ours is reached, which would otherwise leave the permission behind
 * for the next change-triggered store to spend. Keyed only by name, one
 * writer's reclamation took back the other's and that store wrote nothing.
 *
 * It also carries the result, because "did MY write land" is a different
 * question from "does this document hold unstored content", and the gate used
 * to ask the second one to answer the first. They disagree in both directions:
 * an edit arriving during the write makes a landed write read as refused, and
 * a document forgotten mid-attempt makes a write that never happened read as
 * stored.
 */
const armed = new Map<string, ArmRecord>();

/**
 * Bumped every time a document is forgotten.
 *
 * A store the caller stopped waiting for is not cancelled — nothing can
 * cancel a database write in flight — so it can still land minutes later and
 * try to record what it covered. If the document was forgotten in between,
 * that record would be against a counter that no longer exists: `storedCount`
 * comes back without a matching `changeCount`, and the document then reads as
 * saved until it accumulates more changes than the orphan claims. Measured:
 * a 40-change session left later edits reading as already stored.
 */
const generation = new Map<string, number>();

/**
 * Record that a document changed, whatever the origin of the update.
 * @param documentName - Full Yjs document name.
 */
export function noteDocumentChange(documentName: string): void {
  changeCount.set(documentName, (changeCount.get(documentName) ?? 0) + 1);
}

/**
 * Whether a document holds content no successful store has covered.
 * @param documentName - Full Yjs document name.
 * @returns True when the database's copy is behind the one in memory.
 */
export function hasUnsavedContent(documentName: string): boolean {
  return (changeCount.get(documentName) ?? 0) > (storedCount.get(documentName) ?? 0);
}

/** What a store has to hand back to record what it covered. */
export interface StoreTicket {
  /** Update count the write will cover. */
  covered: number;
  /** Which lifetime of this document the write belongs to. */
  generation: number;
}

/**
 * Snapshot what a store is about to cover, before it writes anything.
 *
 * Must be called before the write, never after: anything that lands while the
 * write is in flight is not in the bytes the database received, and has to
 * still read as unsaved once it returns.
 * @param documentName - Full Yjs document name.
 * @returns A ticket to hand {@link commitStore} if the write succeeds.
 */
export function beginStore(documentName: string): StoreTicket {
  return {
    covered: changeCount.get(documentName) ?? 0,
    generation: generation.get(documentName) ?? 0,
  };
}

/**
 * Record that a store succeeded, covering what its ticket claimed.
 *
 * Only ever called on success. A failed store leaves the counters untouched,
 * which is what makes the next round pick the content up again.
 *
 * A ticket from a previous lifetime of the document is discarded: the write
 * it belongs to was abandoned, the document has since been forgotten, and
 * recording it would leave a `storedCount` with no `changeCount` beside it.
 * @param documentName - Full Yjs document name.
 * @param ticket - What {@link beginStore} returned for this write.
 */
export function commitStore(documentName: string, ticket: StoreTicket): void {
  if ((generation.get(documentName) ?? 0) !== ticket.generation) return;
  storedCount.set(documentName, ticket.covered);
}

/** One writer's permission to store one document once. */
export interface StoreArm {
  /** Identifies the attempt, so only its issuer can take it back. */
  token: symbol;
}

/** What one write did, as reported by the extension that made it. */
export type StoreOutcome = "stored" | "refused";

/** What an attempt's issuer learns when it hands the permission back. */
export interface ArmResult {
  /**
   * Whether the persistence extension ran at all for this attempt.
   *
   * False covers three different things that all mean "we never got to
   * write": the hook chain was aborted upstream, we stopped waiting before it
   * reached us, or the document was forgotten in the meantime. The gate must
   * not name a cause it cannot see.
   */
  ran: boolean;
  /** Present once the write finished; absent while it is still in flight. */
  outcome?: StoreOutcome;
}

/**
 * Permit exactly one store for a document.
 *
 * The timed loop and the unload gate call this immediately before asking the
 * library to store. Our persistence extension consumes it; a store the
 * library started on its own finds nothing and returns without encoding.
 * @param documentName - Full Yjs document name.
 * @returns The arm, to hand back to {@link releaseTimedStoreArm} afterwards.
 */
export function armTimedStore(documentName: string): StoreArm {
  const token = Symbol(documentName);
  armed.set(documentName, { token, ran: false });
  return { token };
}

/**
 * Take the one-shot permission, if it is there.
 * @param documentName - Full Yjs document name.
 * @returns True when this store was initiated by us; false otherwise.
 */
export function consumeTimedStoreArm(documentName: string): boolean {
  const record = armed.get(documentName);
  if (!record || record.ran) return false;
  // Marked rather than deleted. The record is what carries the result back to
  // whoever issued it, so it has to outlive being spent.
  record.ran = true;
  return true;
}

/**
 * Record what the write this permission authorised actually did.
 *
 * Called by the persistence extension, which is the only code that knows.
 * Silently ignored when the permission has moved on — a write whose document
 * was forgotten, or whose permission was superseded, has nobody to report to.
 * @param documentName - Full Yjs document name.
 * @param outcome - What the write did.
 */
export function noteStoreOutcome(documentName: string, outcome: StoreOutcome): void {
  const record = armed.get(documentName);
  if (!record || !record.ran) return;
  record.outcome = outcome;
}

/**
 * Hand the permission back, and learn what became of the attempt.
 *
 * Answers two questions nothing else in the system can. Did our persistence
 * hook actually run? A store can resolve without it having run at all, because
 * `hooks()` chains the extensions with `.then` and an upstream rejection skips
 * every hook behind it — which is exactly what the Redis extension does when
 * another instance holds the cross-instance store lock. The library catches
 * that and resolves normally, so from outside it looks like a completed store.
 * And if it did run, what did its write do? That is the question the gate needs
 * and the one it used to answer by asking whether the document is dirty, which
 * is a different question with a different answer.
 * @param documentName - Full Yjs document name.
 * @param arm - What {@link armTimedStore} returned for this attempt.
 * @returns Whether our extension ran for this attempt, and what its write did.
 */
export function releaseTimedStoreArm(documentName: string, arm: StoreArm): ArmResult {
  const record = armed.get(documentName);
  // Not ours any more: superseded by another writer, or the document was
  // forgotten. Either way this attempt has nothing to report and nothing to
  // take back, and "no answer" must not be mistaken for "it worked".
  if (!record || record.token !== arm.token) return { ran: false };
  armed.delete(documentName);
  return record.outcome === undefined
    ? { ran: record.ran }
    : { ran: record.ran, outcome: record.outcome };
}

/**
 * Drop every trace of a document, once it has left memory.
 *
 * Without this the maps grow for the lifetime of the process, one entry per
 * document ever opened.
 * @param documentName - Full Yjs document name.
 */
export function forgetDocument(documentName: string): void {
  changeCount.delete(documentName);
  storedCount.delete(documentName);
  armed.delete(documentName);
  // Not deleted — bumped. A write still in flight carries a ticket from the
  // lifetime that just ended, and this is what makes its late commit a no-op.
  generation.set(documentName, (generation.get(documentName) ?? 0) + 1);
}
