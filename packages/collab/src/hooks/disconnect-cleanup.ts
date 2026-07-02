// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * On-disconnect cleanup for mini-tool operation locks (the mini-tool
 * state-machine ADR, 2026-05-11, §D4).
 *
 * Hocuspocus fires `onDisconnect` when a client's WebSocket closes. For
 * each canvas doc the client was holding, we strip `data.operationLocks`
 * entries with `userId === disconnected` so a configure-phase lock does
 * not outlive its holder.
 *
 * Deliberately *not* touched:
 *
 *   - `data.locked` (user manual lock — user-owned, disconnect-resistant)
 *   - `state === 'handling'` (ANY driver). Disconnect is NOT reliable
 *     evidence that in-flight work died: a frontend upload is a presigned
 *     PUT direct to object storage — invisible to collab and outliving
 *     the WebSocket — and the WS can drop on mere network jitter.
 *     Reclaiming handling on disconnect therefore false-reclaims LIVE
 *     uploads (a sibling tab of the same user, #3; a jitter blip, #11).
 *     Instead the owner self-cleans on upload failure (`setNodeError`),
 *     the Worker self-manages backend handling via NodeStateUpdateEvent,
 *     and the 1h handling-lease sweeper is the guaranteed backstop for
 *     anything that hard-crashed. (#1580 slice 4, Option A — "events
 *     accelerate, the timeout guarantees"; the disconnect accelerator is
 *     dropped because it cannot be made safe. Adversarial design:
 *     workflow wf_2fef6b9b-c1e.)
 *
 * Algorithm is a naive single-doc full scan with a single `doc.transact`.
 * Operation locks are sparse (typical 0–2 entries per node), disconnects
 * are low-frequency, scan is `O(N nodes)` with `N` typically 100–500 →
 * ~1 ms CPU. The simplicity beats a side index (coherence-bug risk on
 * every lock add/remove). See ADR §D4.
 */

import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { parseDocName } from "@breatic/shared";
import type { OperationLock } from "@breatic/shared";
import { createLogger } from "@breatic/core";

const logger = createLogger("disconnect-cleanup");

/**
 * Run the cleanup pass for one user disconnecting from one canvas doc.
 * Strips the disconnected user's `operationLocks`; `handling` state is
 * left untouched for every driver (see the module doc for why — Option A,
 * #1580 slice 4). Idempotent: re-running yields the same result.
 * @param hocuspocus - The running Hocuspocus instance.
 * @param documentName - Yjs doc the user just disconnected from.
 * @param userId - The user whose `operationLocks` to strip.
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

  // SAFETY (#1567, verified 2026-07-02): awaiting openDirectConnection on
  // the SAME doc from inside the onDisconnect hook chain does NOT deadlock
  // and does NOT recurse — unlike the proven afterLoadDocument deadlock
  // (feedback_hocuspocus_after_load_no_await_same_doc), no pending per-doc
  // LOAD promise is held here (the doc finished loading long before any
  // disconnect). Pinned by a real-Hocuspocus regression test
  // (disconnect-cleanup-reentry.test.ts: unloadImmediately + in-memory
  // store + production-shaped wiring) plus two days of dev logs with zero
  // system-context disconnect lines. Do NOT copy this pattern into LOAD
  // hooks (afterLoadDocument / onLoadDocument) — that one really hangs.
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
        });
      }, "collab-disconnect-cleanup");
    });
  } finally {
    await connection.disconnect();
  }

  if (opLockHits > 0) {
    logger.info(
      { documentName, userId, opLockHits },
      "disconnect cleanup applied",
    );
  }
}
