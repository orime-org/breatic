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
  forgetDocument,
  hasUnsavedContent,
} from "@collab/services/store-tracker.js";

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        deps.storeNow({ name: documentName }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deps.finalAttemptTimeoutMs);
        }),
      ]);
    } catch (err) {
      // Whether it threw or timed out changes nothing: the counters, not
      // this call's outcome, say whether the content landed.
      logger.warn({ err, documentName }, "collab_final_store_attempt_errored");
    } finally {
      if (timer) clearTimeout(timer);
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
    if (!rescuePath) return;
    await deps.alert({
      documentName,
      rescuePath,
      bytes,
      reason: "the final store attempt did not land",
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
      } finally {
        // Either the content is safe or it is on disk and reported. Keeping
        // the counters would leak one entry per document ever opened.
        forgetDocument(payload.documentName);
      }
    },

    settleForShutdown: async (payload): Promise<void> => {
      try {
        await settleForShutdown(payload);
      } catch (err) {
        logger.error({ err, documentName: payload.documentName }, "collab_shutdown_settle_failed");
      } finally {
        forgetDocument(payload.documentName);
      }
    },
  };
}
