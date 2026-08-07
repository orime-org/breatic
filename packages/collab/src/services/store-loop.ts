// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

const logger = createLogger("collab-store-loop");

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
  /** Run exactly one round now; a no-op while another round is in flight. */
  runOnce(): Promise<void>;
}

/**
 * Build the timed store loop.
 * @param deps - Interval, the document source, and the store call.
 * @returns The loop, not yet started.
 */
export function createStoreLoop(deps: StoreLoopDeps): StoreLoop {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  /**
   * Store every document that has content the database has not accepted.
   * @returns Resolves when the round is over.
   */
  async function runOnce(): Promise<void> {
    // A slow database can make a round outlast the interval. Overlapping
    // rounds would put two writes of the same document in flight at once,
    // and the second would carry a snapshot taken before the first landed.
    if (inFlight) return;
    inFlight = true;
    try {
      for (const entry of deps.listDocuments()) {
        if (!hasUnsavedContent(entry.name)) continue;
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
          // Caught rather than allowed to escape: one document must not stop
          // the round from reaching the documents behind it, each of which is
          // holding unstored content too.
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
              // Our extension ran and still said nothing, which it only does
              // when it threw before reaching its own try block — encoding the
              // document is the one step out there.
              outcome: result.ran ? "no-result" : "not-reached",
            },
            "collab_store_round_document_unconfirmed",
          );
        }
      }
    } finally {
      inFlight = false;
    }
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
