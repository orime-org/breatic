// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Per-document bookkeeping for "does this document hold content the database
 * has never accepted", and for "was this store started by us".
 *
 * @hocuspocus/server 4.5.0 answers neither question. `Document` carries a
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

/** Documents for which a store initiated by us is permitted exactly once. */
const armed = new Set<string>();

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

/**
 * Snapshot what a store is about to cover, before it writes anything.
 *
 * Must be called before the write, never after: anything that lands while the
 * write is in flight is not in the bytes the database received, and has to
 * still read as unsaved once it returns.
 * @param documentName - Full Yjs document name.
 * @returns The update count the pending write will cover.
 */
export function beginStore(documentName: string): number {
  return changeCount.get(documentName) ?? 0;
}

/**
 * Record that a store succeeded, covering the count {@link beginStore} gave.
 *
 * Only ever called on success. A failed store leaves the counters untouched,
 * which is what makes the next round pick the content up again.
 * @param documentName - Full Yjs document name.
 * @param covered - The value {@link beginStore} returned for this write.
 */
export function commitStore(documentName: string, covered: number): void {
  storedCount.set(documentName, covered);
}

/**
 * Permit exactly one store for a document.
 *
 * The timed loop and the unload gate call this immediately before asking the
 * library to store. Our persistence extension consumes it; a store the
 * library started on its own finds nothing and returns without encoding.
 * @param documentName - Full Yjs document name.
 */
export function armTimedStore(documentName: string): void {
  armed.add(documentName);
}

/**
 * Take the one-shot permission, if it is there.
 * @param documentName - Full Yjs document name.
 * @returns True when this store was initiated by us; false otherwise.
 */
export function consumeTimedStoreArm(documentName: string): boolean {
  return armed.delete(documentName);
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
}
