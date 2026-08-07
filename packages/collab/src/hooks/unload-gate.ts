// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The last thing that runs before a document leaves memory (#40).
 *
 * Measured behaviour of hocuspocus 4.5.0 without this hook: a store fails,
 * the last client closes their tab, no further attempt is made at all, the
 * document is unloaded, and reopening it once the database recovers shows an
 * empty document. From the moment the document is destroyed nothing holds
 * that content — not the browser, not another instance, not the database.
 *
 * So this is the one place left to act, and it gets exactly one attempt.
 * Holding the document instead would protect the content but hand a long
 * outage the ability to fill memory with every document ever opened, and a
 * collab that falls over costs everyone rather than one person.
 *
 * IT MUST NEVER THROW. hocuspocus aborts the unload when a
 * `beforeUnloadDocument` hook rejects, which would strand the document in
 * memory with zero connections and no further re-check to release it.
 */

import type * as Y from "yjs";
import { createLogger } from "@breatic/core";
import type { StoreFailureAlert } from "@collab/services/store-alert.js";
import type { RescueNote } from "@collab/services/rescue-file.js";
import {
  armTimedStore,
  hasUnsavedContent,
  releaseTimedStoreArm,
} from "@collab/services/store-tracker.js";
import { runWithTimeout } from "@collab/services/with-timeout.js";

const logger = createLogger("collab-unload-gate");

/**
 * What the one final store attempt turned out to be.
 *
 * Three of these used to be one. The gate asked a single question — "does the
 * document still hold unstored content?" — and reported every yes as "the
 * database refused it", which is true of only one of them:
 *
 *   refused      our extension ran, the write came back, the content did not
 *                land. The database really did say no.
 *   not-reached  our extension never ran. `hooks()` chains the extensions with
 *                `.then`, so a rejection from any of them skips every hook
 *                behind it — and the Redis extension, which runs first, rejects
 *                exactly that way when another instance holds the
 *                cross-instance store lock. The library catches it and resolves
 *                normally, so the attempt looks identical to a completed one.
 *   unknown      our extension ran and we stopped waiting. Giving up cancels
 *                nothing; the write may land seconds later.
 *
 * Telling an operator a healthy database rejected content it never saw, or very
 * probably accepted, costs real attention during an outage.
 */
type FinalAttempt = "stored" | "refused" | "not-reached" | "unknown";

/** One attempt's outcome, plus whatever it threw on the way. */
interface AttemptResult {
  attempt: FinalAttempt;
  /**
   * What the attempt threw, if anything.
   *
   * Usually nothing even when the store failed: the library swallows store
   * errors, so "refused" normally arrives silently and the counters are the
   * only evidence. Carried anyway so the one log line that reports the loss
   * holds the cause too, rather than leaving an operator to correlate it with
   * a different line by document name.
   */
  error?: unknown;
}

/** How each outcome is explained to whoever reads the alert. */
const ATTEMPT_REASON: Record<Exclude<FinalAttempt, "stored">, string> = {
  refused: "the final store attempt did not land",
  "not-reached":
    "this instance's write never ran — another instance held the cross-instance " +
    "store lock, so the content may already be safe, but this instance could not confirm it",
  unknown:
    "the final store attempt had not come back when this instance stopped waiting, " +
    "so it may still have landed — check the document in the database before acting on this file",
};

/** A document the gate is settling. */
export interface UnloadGateEntry {
  /** Full Yjs document name. */
  name: string;
}

/** Collaborators the gate needs. */
export interface UnloadGateDeps {
  /** How long the final attempt gets before it counts as failed. */
  finalAttemptTimeoutMs: number;
  /** Which collab instance this is — the rescue file only exists on this host. */
  instanceId: string;
  /** Turn a live document into the bytes to store or rescue. */
  encode(document: Y.Doc): Uint8Array;
  /** Ask hocuspocus to store this document immediately. */
  storeNow(entry: UnloadGateEntry): Promise<void>;
  /** Write content that could not be stored to local disk. */
  writeRescue(args: { documentName: string; state: Uint8Array }): Promise<string>;
  /** Write the note that says what a rescue file is and why it exists. */
  writeRescueNote(rescuePath: string, note: RescueNote): Promise<void>;
  /** Remove a rescue file whose content reached the database after all. */
  deleteRescue(path: string): Promise<void>;
  /** Tell operations about a rescued document. */
  alert(failure: StoreFailureAlert): Promise<void>;
}

/** What hocuspocus hands the unload hook. */
export interface UnloadPayload {
  documentName: string;
  document: Y.Doc;
}

/** What the shutdown path is given, plus an optional step recorder. */
export interface ShutdownPayload extends UnloadPayload {
  /** Called with each step as it starts; used by tests to pin the order. */
  onStep?: (step: "rescue" | "store") => void;
}

/** The gate, in its two orders. */
export interface UnloadGate {
  /** Normal unload: try the database first, fall back to disk. */
  beforeUnloadDocument(payload: UnloadPayload): Promise<void>;
  /** Shutdown: write one document to disk first, then try the database. */
  settleForShutdown(payload: ShutdownPayload): Promise<void>;
  /**
   * Shutdown: settle everything still in memory, before anything is destroyed.
   * @param entries - Every document the instance currently holds.
   */
  settleAllForShutdown(entries: Iterable<UnloadPayload>): Promise<void>;
}

/**
 * Build the unload gate.
 * @param deps - Timeout, encoder, store call, rescue I/O, and alerting.
 * @returns The gate in both its orders.
 */
export function createUnloadGate(deps: UnloadGateDeps): UnloadGate {
  /**
   * Documents whose one attempt has already been spent on the way out.
   *
   * `server.destroy()` runs after the shutdown settle and drives the ordinary
   * unload path over the same documents. Without this they would get a second
   * rescue file and a second alert for content that has already been settled —
   * and "one attempt" was a decision, not an accident.
   */
  const settledForShutdown = new Set<string>();

  /**
   * Make one store attempt, giving up after the configured timeout.
   *
   * A timeout is not optional here: the yjs pool inherits postgres.js's
   * 30-second connect timeout, which is several times the whole shutdown
   * budget, so waiting for it would mean losing the rescue file too.
   * @param documentName - Full Yjs document name.
   * @returns What the attempt turned out to be.
   */
  async function attemptStore(documentName: string): Promise<AttemptResult> {
    const arm = armTimedStore(documentName);
    const outcome = await runWithTimeout(
      deps.storeNow({ name: documentName }),
      deps.finalAttemptTimeoutMs,
    );
    if (outcome.error) {
      logger.warn({ err: outcome.error, documentName }, "collab_final_store_attempt_errored");
    }
    // Hand our own permission back and read what became of it. This is the
    // whole answer: whether our extension ran, and what its write did. Handing
    // back the token rather than deleting by name is what keeps this from
    // taking the timed loop's permission instead of ours.
    const result = releaseTimedStoreArm(documentName, arm);
    const error = outcome.error;

    if (!result.ran) return { attempt: "not-reached", error };
    if (result.outcome === "stored") return { attempt: "stored", error };
    if (result.outcome === "refused") return { attempt: "refused", error };
    // It ran and has not reported. That is a write still in flight, whether or
    // not our own deadline is what stopped us waiting for it.
    return { attempt: "unknown", error };
  }

  /**
   * Put the content on disk and tell operations where it is.
   * @param documentName - Full Yjs document name.
   * @param state - The bytes the database would not take.
   * @returns Path of the rescue file, or undefined when even that failed.
   */
  async function rescue(documentName: string, state: Uint8Array): Promise<string | undefined> {
    try {
      return await deps.writeRescue({ documentName, state });
    } catch (err) {
      // Nothing is left to try. Log loudly: this is the case where content
      // really is gone with no copy anywhere.
      logger.error({ err, documentName, bytes: state.length }, "collab_rescue_write_failed");
      return undefined;
    }
  }

  /**
   * Report a document whose content the database was never confirmed to hold.
   * @param documentName - Full Yjs document name.
   * @param bytes - How much content was at stake.
   * @param rescuePath - Where it was written, when it was.
   * @param result - Why the content is unaccounted for.
   * @param result.attempt - Which of the three failures this was.
   * @param result.error - What the attempt threw, if it threw at all.
   */
  async function reportLoss(
    documentName: string,
    bytes: number,
    rescuePath: string | undefined,
    result: { attempt: Exclude<FinalAttempt, "stored">; error?: unknown },
  ): Promise<void> {
    const { attempt, error } = result;
    const reason = ATTEMPT_REASON[attempt];
    logger.error(
      { err: error ?? null, documentName, bytes, rescuePath: rescuePath ?? null, attempt },
      "collab_store_unrecoverable",
    );
    if (rescuePath) {
      // The file on its own is an opaque binary with a flattened name. The
      // note is what turns it back into "this document, on this host, at this
      // time, for this reason".
      try {
        await deps.writeRescueNote(rescuePath, {
          documentName,
          instanceId: deps.instanceId,
          bytes,
          reason,
          writtenAt: new Date().toISOString(),
        });
      } catch (err) {
        // The content itself is already safe on disk; losing its description
        // is bad but not a reason to skip telling anyone about it.
        logger.error({ err, documentName, rescuePath }, "collab_rescue_note_write_failed");
      }
    }
    // Told even when there is no file. That case is the worst one — the
    // content now has no copy anywhere — and it is also the one an operator
    // can still act on, by fixing the rescue directory before the next
    // document is lost the same way.
    await deps.alert({
      documentName,
      rescuePath: rescuePath ?? "",
      bytes,
      reason: rescuePath
        ? reason
        : `${reason} AND the rescue file could not be written — this content has no copy anywhere`,
    });
  }

  /**
   * Ordinary unload: try the database, fall back to disk.
   * @param payload - The document about to leave memory.
   * @param payload.documentName - Full Yjs document name.
   * @param payload.document - The live document.
   */
  async function settleNormally({ documentName, document }: UnloadPayload): Promise<void> {
    if (!hasUnsavedContent(documentName)) return;

    const result = await attemptStore(documentName);
    // Two separate questions. What the attempt did decides what the operator
    // is told; whether the document still holds unstored content decides
    // whether there is anything left to rescue. A write can land AND leave the
    // document dirty, when an edit arrived while it was in flight.
    if (!hasUnsavedContent(documentName)) return;

    const state = deps.encode(document);
    const path = await rescue(documentName, state);
    await reportLoss(documentName, state.length, path, {
      attempt: result.attempt === "stored" ? "unknown" : result.attempt,
      error: result.error,
    });
  }

  /**
   * Shutdown: write to disk first, then try the database.
   * @param payload - The document about to leave memory, plus a step recorder.
   * @param payload.documentName - Full Yjs document name.
   * @param payload.document - The live document.
   * @param payload.onStep - Called with each step as it starts.
   */
  async function settleForShutdown({
    documentName,
    document,
    onStep,
  }: ShutdownPayload): Promise<void> {
    if (!hasUnsavedContent(documentName)) return;

    // Disk first. The whole shutdown budget is a few seconds and one database
    // attempt can outlast it, so the fast local write has to happen while
    // there is still a process to do it.
    onStep?.("rescue");
    const state = deps.encode(document);
    const path = await rescue(documentName, state);

    onStep?.("store");
    const result = await attemptStore(documentName);

    // Both, not either. The file is the only copy, so it goes only when this
    // attempt explicitly reported landing AND nothing has come in since. A
    // document forgotten mid-attempt reports neither, and used to read as
    // stored — which deleted the file.
    if (result.attempt === "stored" && !hasUnsavedContent(documentName)) {
      if (path) await deps.deleteRescue(path);
      return;
    }
    await reportLoss(documentName, state.length, path, {
      attempt: result.attempt === "stored" ? "unknown" : result.attempt,
      error: result.error,
    });
  }

  return {
    beforeUnloadDocument: async (payload): Promise<void> => {
      try {
        if (settledForShutdown.has(payload.documentName)) return;
        await settleNormally(payload);
      } catch (err) {
        // Belt and braces. A throw escaping here would abort the unload and
        // strand the document; nothing this hook does is worth that.
        logger.error({ err, documentName: payload.documentName }, "collab_unload_gate_failed");
      }
      // Deliberately no cleanup here. The library re-checks
      // `shouldUnloadDocument` AFTER this hook returns and abandons the unload
      // if a connection arrived meanwhile, so a document can survive this
      // call. Clearing the counters here would mark a live document holding
      // unstored content as clean, and the timed loop would skip it from then
      // on. Cleanup belongs to the change-tracking extension, which owns the
      // bookkeeping and drops it in `afterUnloadDocument` — the one hook that
      // fires only once the document has actually gone.
    },

    settleForShutdown: async (payload): Promise<void> => {
      settledForShutdown.add(payload.documentName);
      try {
        await settleForShutdown(payload);
      } catch (err) {
        logger.error({ err, documentName: payload.documentName }, "collab_shutdown_settle_failed");
      }
    },

    settleAllForShutdown: async (entries): Promise<void> => {
      // Concurrently, not one after another. Each document's attempt is
      // bounded, but a hundred of them in series is a hundred times that, and
      // the process is on a deadline it does not control. They are independent
      // writes of independent rows; the pool queues them.
      await Promise.all(
        Array.from(entries, async (payload) => {
          settledForShutdown.add(payload.documentName);
          try {
            await settleForShutdown(payload);
          } catch (err) {
            // One document must not take the rest of the shutdown with it.
            logger.error(
              { err, documentName: payload.documentName },
              "collab_shutdown_settle_failed",
            );
          }
        }),
      );
    },
  };
}
