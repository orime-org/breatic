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

const logger = createLogger("collab-unload-gate");

/**
 * What the one final store attempt turned out to be.
 *
 * The attempt is waited out, so every one of these is something that actually
 * happened rather than something a clock decided. There used to be a fifth,
 * "we stopped waiting", and it was the source of three operator alerts in smoke
 * against a database answering in 250ms.
 *
 *   stored       our extension ran and its write landed.
 *   refused      our extension ran, the write came back, the content did not
 *                land. The database really did say no.
 *   raced-by-edit the write landed, and content arrived while it was in flight,
 *                so the database holds a copy that is already behind.
 *   not-reached  our extension never ran: the permission we issued was still
 *                unspent. `hooks()` chains the extensions with `.then`, so a
 *                rejection from any of them skips every hook behind it, and the
 *                library catches that and resolves normally — from out here the
 *                attempt looks identical to a completed one. WHICH extension
 *                aborted it is not visible, so the operator text names none.
 *   unconfirmed  we cannot say what happened: another writer superseded our
 *                attempt, the document left memory before we got there, or our
 *                extension ran and threw before it could report. None of them
 *                is "nothing reached us".
 *
 * Telling an operator a healthy database rejected content it never saw, or very
 * probably accepted, costs real attention during an outage.
 */
type FinalAttempt = "stored" | "refused" | "raced-by-edit" | "not-reached" | "unconfirmed";

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
  "raced-by-edit":
    "the final store attempt landed, but content arrived while it was in flight and " +
    "is not in the database — this file holds the newer copy",
  "not-reached":
    "this instance's write never ran, and it cannot tell why — the store hook chain " +
    "was aborted before it reached us. Check the document in the database before " +
    "acting on this file",
  unconfirmed:
    "this instance could not confirm what happened to its write — another attempt " +
    "took over, or the document left memory first. Check the document in the " +
    "database before acting on this file",
};

/** A document the gate is settling. */
export interface UnloadGateEntry {
  /** Full Yjs document name. */
  name: string;
}

/** Collaborators the gate needs. */
export interface UnloadGateDeps {
  /** Which collab instance this is — the rescue file only exists on this host. */
  instanceId: string;
  /** Turn a live document into the bytes to store or rescue. */
  encode(document: Y.Doc): Uint8Array;
  /**
   * Ask hocuspocus to store this document immediately.
   * @returns Whether the document was still loaded. False means the library
   *   unloaded it before we got there, so nothing was written and nothing
   *   could be.
   */
  storeNow(entry: UnloadGateEntry): Promise<boolean>;
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
  /**
   * The process is going down: write to disk before the database from now on,
   * and give each document exactly one attempt across both paths.
   */
  markShuttingDown(): void;
}

/**
 * Build the unload gate.
 * @param deps - Timeout, encoder, store call, rescue I/O, and alerting.
 * @returns The gate in both its orders.
 */
export function createUnloadGate(deps: UnloadGateDeps): UnloadGate {
  /**
   * Documents somebody is settling, or has settled, right now.
   *
   * A claim rather than a mark, because both paths want the same documents and
   * either can get there first. `server.destroy()` drives the ordinary unload
   * over exactly the documents the shutdown walk enumerates, and the library
   * keeps a document reachable for the whole of `beforeUnloadDocument` — it
   * leaves `instance.documents` only after that chain resolves. A one-way mark
   * caught only one of the two orders; the other produced two rescue files for
   * one document, with the second alert swallowed by the per-document window,
   * so an operator was told about one file and would find two.
   *
   * Released once the settle finishes, EXCEPT while shutting down. In ordinary
   * operation the library may abandon an unload after the hook returns (a
   * connection arrived), and that document's next real departure deserves its
   * own attempt — the claim is for one departure, not for the document's life.
   * On the way out there is no next departure, so it stands.
   */
  const settling = new Set<string>();

  /** True once the process is going down; see {@link UnloadGate.markShuttingDown}. */
  let shuttingDown = false;

  /**
   * Take the one attempt for a document, if nobody else has it.
   * @param documentName - Full Yjs document name.
   * @returns True when this caller may settle it.
   */
  function claim(documentName: string): boolean {
    if (settling.has(documentName)) return false;
    settling.add(documentName);
    return true;
  }

  /**
   * Give the claim back, so a later departure can be settled too.
   * @param documentName - Full Yjs document name.
   */
  function releaseClaim(documentName: string): void {
    if (shuttingDown) return;
    settling.delete(documentName);
  }

  /**
   * Make the one store attempt, and wait for its answer.
   *
   * Waited out rather than raced against a clock. Storing is one event with
   * two outcomes, and only the write can say which it was — a deadline cancels
   * nothing, so giving up on one yields no answer, just a third state that then
   * gets rescued and mailed to an operator as though something were wrong.
   * @param documentName - Full Yjs document name.
   * @returns What the attempt turned out to be.
   */
  async function attemptStore(documentName: string): Promise<AttemptResult> {
    const arm = armTimedStore(documentName);
    let stillLoaded = true;
    let error: unknown;
    try {
      stillLoaded = await deps.storeNow({ name: documentName });
    } catch (err) {
      // The library swallows store errors, so this is the rare path — an
      // extension throwing outside its own handling. Caught because this hook
      // must never throw: hocuspocus aborts the unload when it does, which
      // strands the document in memory with nothing left to release it.
      error = err;
      logger.warn({ err, documentName }, "collab_final_store_attempt_errored");
    }
    // Hand our own permission back and read what became of it. This is the
    // whole answer: whether our extension ran, and what its write did. Handing
    // back the token rather than deleting by name is what keeps this from
    // taking the timed loop's permission instead of ours.
    const result = releaseTimedStoreArm(documentName, arm);

    // The document going away first looks exactly like an unspent permission
    // from here — we arm, nothing consumes it — but they are different events
    // and only the lookup knows which happened. On the shutdown path the rescue
    // file is written before the store is attempted, so the library has a whole
    // disk write in which to unload the document out from under us.
    if (!stillLoaded) return { attempt: "unconfirmed", error };
    // Of the rest, only an unspent permission means nothing reached our
    // extension; superseded and gone both mean we cannot say.
    if (!result.ran) {
      return { attempt: result.reason === "unspent" ? "not-reached" : "unconfirmed", error };
    }
    if (result.outcome === "stored") return { attempt: "stored", error };
    if (result.outcome === "refused") return { attempt: "refused", error };
    // It ran and reported nothing, which it only does by throwing before its
    // own try block — encoding the document is the one step out there.
    return { attempt: "unconfirmed", error };
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
      // Landed, and still dirty: the only way both hold is that content
      // arrived during the write. Saying "it did not land" here would be
      // false, and it is the one case where the database has a real, if
      // slightly older, copy.
      attempt: result.attempt === "stored" ? "raced-by-edit" : result.attempt,
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

    // Disk first. A store can take as long as the database takes, and this is
    // the last moment the content exists anywhere, so the fast local write
    // happens while there is certainly still a process to do it.
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
      // Same pairing as the ordinary path: landed AND still dirty means an
      // edit arrived mid-write, and the file is the copy that has it.
      attempt: result.attempt === "stored" ? "raced-by-edit" : result.attempt,
      error: result.error,
    });
  }

  return {
    beforeUnloadDocument: async (payload): Promise<void> => {
      if (!claim(payload.documentName)) return;
      try {
        // Disk first once the process is going down: a store takes as long as
        // the database takes, and the local write is quick and certain.
        await (shuttingDown ? settleForShutdown(payload) : settleNormally(payload));
      } catch (err) {
        // Belt and braces. A throw escaping here would abort the unload and
        // strand the document; nothing this hook does is worth that.
        logger.error({ err, documentName: payload.documentName }, "collab_unload_gate_failed");
      } finally {
        releaseClaim(payload.documentName);
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

    markShuttingDown: (): void => {
      shuttingDown = true;
    },

    settleForShutdown: async (payload): Promise<void> => {
      if (!claim(payload.documentName)) return;
      try {
        await settleForShutdown(payload);
      } catch (err) {
        logger.error({ err, documentName: payload.documentName }, "collab_shutdown_settle_failed");
      } finally {
        releaseClaim(payload.documentName);
      }
    },

    settleAllForShutdown: async (entries): Promise<void> => {
      // Concurrently, not one after another. A hundred documents in series is
      // a hundred database round trips end to end, on the way out, when the
      // supervisor is already waiting. They are independent writes of
      // independent rows; the pool queues them.
      await Promise.all(
        Array.from(entries, async (payload) => {
          // Whoever gets here first settles it. The other path finds the claim
          // taken and stands down.
          if (!claim(payload.documentName)) return;
          try {
            await settleForShutdown(payload);
          } catch (err) {
            // One document must not take the rest of the shutdown with it.
            logger.error(
              { err, documentName: payload.documentName },
              "collab_shutdown_settle_failed",
            );
          } finally {
            releaseClaim(payload.documentName);
          }
        }),
      );
    },
  };
}
