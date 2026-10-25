// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The timed store loop (#40).
 *
 * Storing is driven from here rather than from "somebody changed something",
 * so that a failed write has no consequence for whoever made the edit and,
 * more importantly, so that it is retried at all. hocuspocus 4.5.0 does not
 * retry — measured, despite what its release notes say — and an idle
 * document produces no further edits to piggyback a retry on. Without this
 * loop, a single failed write means the content is gone the moment the last
 * client leaves.
 *
 * Every instance holding a document runs its own loop over it. The dirty
 * check makes that cheap: a document nobody has touched since its last
 * successful store costs nothing. What it buys is that an instance dying
 * does not orphan its documents — the others hold the same content (relayed
 * updates count too, see store-tracker) and will write it themselves.
 */

import { createLogger } from "@breatic/core";
import {
  armTimedStore,
  hasUnsavedContent,
  releaseTimedStoreArm,
} from "@collab/services/store-tracker.js";
import type { ArmResult } from "@collab/services/store-tracker.js";

const logger = createLogger("collab-store-loop");

/**
 * Name the state an attempt ended in, for the operator reading the log.
 * @param result - What the attempt's permission came back as.
 * @returns A stable word naming what happened, never one naming what did not.
 */
function unconfirmedOutcome(result: ArmResult): string {
  if (result.ran) return "no-result";
  if (result.reason === "unspent") return "not-reached";
  return result.reason ?? "not-reached";
}

/** One document the loop may have to store. */
export interface StoreLoopEntry {
  /** Full Yjs document name. */
  name: string;
}

/** Collaborators the loop needs. */
export interface StoreLoopDeps {
  /** How long between rounds. */
  intervalMs: number;
  /** Documents currently held in memory. */
  listDocuments(): Iterable<StoreLoopEntry>;
  /**
   * Ask hocuspocus to store this document immediately.
   * @returns Whether the document was still loaded. A document that unloaded
   *   between the listing and the store is ordinary, not a failure.
   */
  storeNow(entry: StoreLoopEntry): Promise<boolean>;
}

/** A running (or startable) timed store loop. */
export interface StoreLoop {
  /** Begin running a round every interval. */
  start(): void;
  /** Stop running rounds. Does not interrupt a round already in flight. */
  stop(): void;
  /**
   * Run exactly one round now.
   * @returns Resolves once every store this round started has come back.
   *   Documents already being stored by an earlier round are skipped, so a
   *   write that never answers holds up nothing but itself.
   */
  runOnce(): Promise<void>;
}

/**
 * Build the timed store loop.
 * @param deps - Interval, the document source, and the store call.
 * @returns The loop, not yet started.
 */
export function createStoreLoop(deps: StoreLoopDeps): StoreLoop {
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Documents whose store is out there right now, unanswered.
   *
   * PER DOCUMENT, not per round. What has to be prevented is two writes of the
   * SAME document overlapping — the second would carry a snapshot taken before
   * the first landed. A whole-round guard prevents that too, but it also lets
   * one document that never answers retire the loop for every other document
   * in the process, and this loop is the only retry mechanism there is: a
   * document nothing re-attempts survives only if it later unloads through the
   * gate, and a SIGKILL loses it. Measured with a wedged store: the healthy
   * document beside it was stored zero times, and every later round returned
   * immediately.
   */
  const storing = new Set<string>();

  /**
   * Store one document and record what became of the attempt.
   * @param entry - The document to store.
   * @returns Resolves when the store has answered, whatever it answered.
   */
  async function storeOne(entry: StoreLoopEntry): Promise<void> {
    // Arm immediately before the call: the persistence extension returns
    // without writing anything when it finds no arm.
    const arm = armTimedStore(entry.name);
    // Waited for, not raced against a clock. A store is one event with two
    // outcomes — it lands or it does not — and only the write itself can
    // say which. A deadline cancels nothing, so giving up on one produces
    // no answer at all, just a third state that then gets reported as if
    // something had gone wrong.
    let stillLoaded = true;
    let storeError: unknown;
    try {
      stillLoaded = await deps.storeNow(entry);
    } catch (err) {
      // Caught rather than allowed to escape: one document must not take the
      // rest of the round down with it.
      storeError = err;
    }
    // Give our own arm back rather than trusting it was consumed. The
    // Redis extension runs first (priority 1000 against our default 100)
    // and aborts the whole hook chain when another instance holds the
    // cross-instance lock, so our hook — and its consumption of the arm —
    // is skipped. A leftover arm would then be spent by the library's own
    // change-triggered store, which is exactly the write this design
    // exists to prevent. Handing back the token rather than deleting by
    // name is what keeps this from taking the unload gate's arm.
    const result = releaseTimedStoreArm(entry.name, arm);

    if (storeError) {
      logger.error(
        { err: storeError, documentName: entry.name },
        "collab_store_round_document_failed",
      );
    }
    // Nothing to retry here and nothing to alert about: the document is
    // still in memory and still reads as holding unstored content, so the
    // next round picks it up. Recorded because a document that never wins
    // the cross-instance lock is invisible otherwise — it just quietly
    // stays dirty round after round.
    // A document that left memory between the listing and the store is
    // ordinary — the unload gate settled it on the way out — so it is not
    // worth a line. Everything else that did not confirm is.
    if (stillLoaded && result.outcome !== "stored" && result.outcome !== "refused") {
      logger.warn(
        {
          documentName: entry.name,
          // The tracker's three reasons, kept apart. Only `unspent` means
          // nothing reached our extension, and it keeps the gate's name for
          // that. `superseded` means the unload gate took the attempt over and
          // may well have stored the document; `gone` means the document was
          // forgotten while we waited. Reporting those two as "nothing reached
          // us" sends whoever is on call hunting an aborted hook chain that is
          // not there. `no-result` is our own extension running and saying
          // nothing, which it only does by throwing before its try block —
          // encoding the document is the one step out there.
          outcome: unconfirmedOutcome(result),
        },
        "collab_store_round_document_unconfirmed",
      );
    }
  }

  /**
   * Store every document that has content the database has not accepted.
   * @returns Resolves when every store this round started has come back.
   */
  async function runOnce(): Promise<void> {
    const started: Array<Promise<void>> = [];
    for (const entry of deps.listDocuments()) {
      if (!hasUnsavedContent(entry.name)) continue;
      if (storing.has(entry.name)) continue;
      storing.add(entry.name);
      started.push(storeOne(entry).finally(() => storing.delete(entry.name)));
    }
    // Concurrently. They are independent writes of independent rows and the
    // pool queues them, so the round costs one slow database rather than one
    // per document — and a document that never answers is one entry in the set
    // above, not a stalled cursor the rest of the round is queued behind.
    await Promise.all(started);
  }

  return {
    start: (): void => {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce();
      }, deps.intervalMs);
      // Never hold the process open for a store round.
      timer.unref?.();
    },
    stop: (): void => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
