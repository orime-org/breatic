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
import {
  armTimedStore,
  consumeTimedStoreArm,
  forgetDocument,
  hasUnsavedContent,
} from "@collab/services/store-tracker.js";
import { runWithTimeout } from "@collab/services/with-timeout.js";

const logger = createLogger("collab-unload-gate");

/** A document the gate is settling. */
export interface UnloadGateEntry {
  /** Full Yjs document name. */
  name: string;
}

/** Collaborators the gate needs. */
export interface UnloadGateDeps {
  /** How long the final attempt gets before it counts as failed. */
  finalAttemptTimeoutMs: number;
  /** Turn a live document into the bytes to store or rescue. */
  encode(document: Y.Doc): Uint8Array;
  /** Ask hocuspocus to store this document immediately. */
  storeNow(entry: UnloadGateEntry): Promise<void>;
  /** Write content that could not be stored to local disk. */
  writeRescue(args: { documentName: string; state: Uint8Array }): Promise<string>;
  /** Remove a rescue file whose content reached the database after all. */
  deleteRescue(path: string): Promise<void>;
  /** Tell operations about a rescued document. */
  alert(failure: StoreFailureAlert): Promise<void>;
  /**
   * Whether the process is shutting down, which reverses the order.
   *
   * A flag rather than a separate shutdown drain, because the drains run in
   * parallel (`Promise.allSettled`), so a drain that settled documents would
   * race the one that destroys the server — and both would be walking the
   * same documents. Setting this before the drains start makes the ordinary
   * unload path, which `server.destroy()` drives anyway, do the right thing.
   */
  isShuttingDown?(): boolean;
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
  /** Shutdown: write to disk first, then try the database. */
  settleForShutdown(payload: ShutdownPayload): Promise<void>;
  /** The document has actually left memory; drop its bookkeeping. */
  afterUnloadDocument(payload: { documentName: string }): void;
}

/**
 * Build the unload gate.
 * @param deps - Timeout, encoder, store call, rescue I/O, and alerting.
 * @returns The gate in both its orders.
 */
export function createUnloadGate(deps: UnloadGateDeps): UnloadGate {
  /**
   * Make one store attempt, giving up after the configured timeout.
   *
   * A timeout is not optional here: the yjs pool inherits postgres.js's
   * 30-second connect timeout, which is several times the whole shutdown
   * budget, so waiting for it would mean losing the rescue file too.
   * @param documentName - Full Yjs document name.
   * @returns Resolves once the attempt finished or the timeout elapsed.
   */
  async function attemptStore(documentName: string): Promise<void> {
    armTimedStore(documentName);
    try {
      await runWithTimeout(deps.storeNow({ name: documentName }), deps.finalAttemptTimeoutMs);
    } catch (err) {
      // Whether it threw or timed out changes nothing: the counters, not
      // this call's outcome, say whether the content landed.
      logger.warn({ err, documentName }, "collab_final_store_attempt_errored");
    } finally {
      // Reclaim our own arm rather than trusting it was consumed — see the
      // same reclamation in the timed loop for why it may not have been.
      consumeTimedStoreArm(documentName);
    }
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
   * Report a document whose content never reached the database.
   * @param documentName - Full Yjs document name.
   * @param bytes - How much content was at stake.
   * @param rescuePath - Where it was written, when it was.
   */
  async function reportLoss(
    documentName: string,
    bytes: number,
    rescuePath: string | undefined,
  ): Promise<void> {
    logger.error(
      { documentName, bytes, rescuePath: rescuePath ?? null },
      "collab_store_unrecoverable",
    );
    // Told even when there is no file. That case is the worst one — the
    // content now has no copy anywhere — and it is also the one an operator
    // can still act on, by fixing the rescue directory before the next
    // document is lost the same way.
    await deps.alert({
      documentName,
      rescuePath: rescuePath ?? "",
      bytes,
      reason: rescuePath
        ? "the final store attempt did not land"
        : "the final store attempt did not land AND the rescue file could not be written — this content has no copy anywhere",
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

    await attemptStore(documentName);
    if (!hasUnsavedContent(documentName)) return;

    const state = deps.encode(document);
    const path = await rescue(documentName, state);
    await reportLoss(documentName, state.length, path);
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
    await attemptStore(documentName);

    if (!hasUnsavedContent(documentName)) {
      if (path) await deps.deleteRescue(path);
      return;
    }
    await reportLoss(documentName, state.length, path);
  }

  return {
    beforeUnloadDocument: async (payload): Promise<void> => {
      try {
        if (deps.isShuttingDown?.()) {
          await settleForShutdown(payload);
          return;
        }
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
      // on. Cleanup belongs to `afterUnloadDocument`, which only fires once
      // the document has actually gone.
    },

    settleForShutdown: async (payload): Promise<void> => {
      try {
        await settleForShutdown(payload);
      } catch (err) {
        logger.error({ err, documentName: payload.documentName }, "collab_shutdown_settle_failed");
      }
    },

    afterUnloadDocument: ({ documentName }): void => {
      // The document has left memory for real. Only now are the counters
      // safe to drop; keeping them would leak one entry per document ever
      // opened, and dropping them any earlier would mislabel a live one.
      forgetDocument(documentName);
    },
  };
}
