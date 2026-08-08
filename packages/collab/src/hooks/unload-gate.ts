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
 *   raced-by-edit the write landed, and content arrived while it was in flight.
 *                The rescue file is encoded AFTER the write, so it holds that
 *                content and the database does not.
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
    "the final store attempt landed, and content arrived while it was in flight that the " +
    "database does not have — this file holds it, and is the newer of the two copies",
  "not-reached":
    "this instance's write never ran, and it cannot tell why — the store hook chain " +
    "was aborted before it reached us. Check the document in the database before " +
    "acting on this file",
  unconfirmed:
    "this instance could not confirm what happened to its write — another attempt " +
    "took over, the document left memory first, or the write threw before it could " +
    "report. Check the document in the database before acting on this file",
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
  /** Tell operations about a rescued document. */
  alert(failure: StoreFailureAlert): Promise<void>;
}

/** What hocuspocus hands the unload hook. */
export interface UnloadPayload {
  documentName: string;
  document: Y.Doc;
}

/** The gate. */
export interface UnloadGate {
  /** Try the database; if that does not land, write the content to disk. */
  beforeUnloadDocument(payload: UnloadPayload): Promise<void>;
}

/**
 * Build the unload gate.
 * @param deps - Instance id, encoder, store call, rescue I/O, and alerting.
 * @returns The gate.
 */
export function createUnloadGate(deps: UnloadGateDeps): UnloadGate {
  /**
   * Documents somebody is settling right now.
   *
   * The library keeps a document reachable for the whole of
   * `beforeUnloadDocument` — it leaves `instance.documents` only after that
   * chain resolves — so a second unload of the same document can begin while
   * the first is still waiting on its write. Without this, one document
   * produced two rescue files, and the second alert was swallowed by the
   * per-document window, so an operator was told about one file and would
   * find two.
   *
   * Released once the settle finishes: the library may abandon an unload after
   * the hook returns (a connection arrived), and that document's next real
   * departure deserves its own attempt. The claim is for one departure, not
   * for the document's life.
   */
  const settling = new Set<string>();

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
    // and only the lookup knows which happened. `storeDocumentNow` reports it
    // directly: it looks the document up in `instance.documents` and returns
    // false when the library has already unloaded it.
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
   * @param result.attempt - Which outcome this was; anything but `stored`.
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
   * Try the database; if the content does not land, write it to disk.
   * @param payload - The document about to leave memory.
   * @param payload.documentName - Full Yjs document name.
   * @param payload.document - The live document.
   */
  async function settle({ documentName, document }: UnloadPayload): Promise<void> {
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
      // arrived during the write. The encode two lines up ran AFTER the
      // attempt, so the file just written holds that content and the database
      // does not.
      attempt: result.attempt === "stored" ? "raced-by-edit" : result.attempt,
      error: result.error,
    });
  }

  return {
    beforeUnloadDocument: async (payload): Promise<void> => {
      if (!claim(payload.documentName)) return;
      try {
        await settle(payload);
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
  };
}
