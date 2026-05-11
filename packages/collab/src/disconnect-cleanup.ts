/**
 * On-disconnect cleanup for mini-tool state (ADR
 * `breatic-inner/decisions/2026-05-11-mini-tool-state-machine.md` §D4).
 *
 * Hocuspocus fires `onDisconnect` when a client's WebSocket closes. For
 * each canvas doc the client was holding, we scan all nodes and:
 *
 *   1. Strip `data.operationLocks` entries with `userId === disconnected`
 *      so the configure-phase lock doesn't outlive the holder.
 *   2. Find `state === 'handling'` nodes where `handlingBy.userId ===
 *      disconnected` AND `handlingBy.type === 'frontend'`, and write
 *      `state: 'idle' + errorMessage: 'Operation interrupted...' +
 *      handlingBy: null`. Frontend-driver handling means the disconnected
 *      browser was the one running the op; nobody else will ever finish it.
 *
 * Deliberately *not* touched:
 *
 *   - `data.locked` (user manual lock — user-owned, disconnect-resistant)
 *   - `state === 'handling'` with `handlingBy.type === 'backend'`
 *     (Worker owns its own lifecycle via NodeStateUpdateEvent)
 *
 * Algorithm is a naive single-doc full scan with a single `doc.transact`
 * wrapping all writes. Operation locks are sparse (typical 0–2 entries
 * per node), disconnects are low-frequency, scan is `O(N nodes)` with
 * `N` typically 100–500 → ~1 ms CPU. The simplicity beats a side index
 * (which has coherence-bug risk on every lock add/remove). See ADR §D4.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { parseDocName } from "@breatic/shared";
import type { OperationLock, HandlingActor } from "@breatic/shared";
import { createLogger } from "./logger.js";

const logger = createLogger("disconnect-cleanup");

/**
 * Run the cleanup pass for one user disconnecting from one canvas doc.
 *
 * Idempotent on the lock-strip path (re-running yields the same result).
 * The handling-cleanup path writes once per affected node; running twice
 * is also safe because the second pass sees `state === 'idle'` already
 * and skips.
 *
 * @param hocuspocus - The running Hocuspocus instance.
 * @param documentName - Yjs doc the user just disconnected from.
 * @param userId - The user whose locks / handling rows to clean.
 */
export async function cleanupOnDisconnect(
  hocuspocus: Hocuspocus,
  documentName: string,
  userId: string,
): Promise<void> {
  // Non-canvas docs (meta, document, timeline) have no `nodesMap` —
  // skip them without opening a connection. parseDocName returns null
  // for unknown / malformed names; we also bail on those.
  const parsed = parseDocName(documentName);
  if (!parsed || parsed.kind !== "canvas") return;

  let opLockHits = 0;
  let handlingHits = 0;

  let connection: Awaited<ReturnType<Hocuspocus["openDirectConnection"]>>;
  try {
    connection = await hocuspocus.openDirectConnection(documentName, {
      context: { user: { id: "system" }, source: "disconnect-cleanup" },
    });
  } catch (err) {
    logger.error(
      { err, documentName, userId },
      "Failed to open Yjs doc for disconnect cleanup; skipping",
    );
    return;
  }

  try {
    await connection.transact((doc: Y.Doc) => {
      // Inner `doc.transact` carries the origin so UndoManager filters
      // this server-side cleanup out of the local undo stack. The outer
      // `connection.transact` from Hocuspocus only takes the callback.
      doc.transact(() => {
        const nodesMap = doc.getMap("nodesMap");
        nodesMap.forEach((nodeMap) => {
          if (!(nodeMap instanceof Y.Map)) return;
          const dataMap = nodeMap.get("data");
          if (!(dataMap instanceof Y.Map)) return;

          // ── operationLocks strip ────────────────────────────
          // Yjs reads a Y.Array as a plain array via toArray(); we
          // replace the whole entry by setting a new array when at
          // least one entry matches the disconnected user. This
          // avoids partial-array splice operations that broadcast
          // multiple Yjs updates.
          const rawLocks = dataMap.get("operationLocks");
          if (Array.isArray(rawLocks)) {
            const filtered = (rawLocks as OperationLock[]).filter(
              (lock) => lock.userId !== userId,
            );
            if (filtered.length !== rawLocks.length) {
              dataMap.set("operationLocks", filtered);
              opLockHits++;
            }
          }

          // ── handling cleanup (frontend-driver only) ─────────
          const state = dataMap.get("state");
          const handlingBy = dataMap.get("handlingBy") as
            | HandlingActor
            | null
            | undefined;
          if (
            state === "handling" &&
            handlingBy &&
            handlingBy.userId === userId &&
            handlingBy.type === "frontend"
          ) {
            dataMap.set("state", "idle");
            dataMap.set(
              "errorMessage",
              "Operation interrupted by client disconnect",
            );
            dataMap.delete("handlingBy");
            handlingHits++;
          }
        });
      }, "collab-disconnect-cleanup");
    });
  } finally {
    await connection.disconnect();
  }

  if (opLockHits > 0 || handlingHits > 0) {
    logger.info(
      { documentName, userId, opLockHits, handlingHits },
      "disconnect cleanup applied",
    );
  }
}
