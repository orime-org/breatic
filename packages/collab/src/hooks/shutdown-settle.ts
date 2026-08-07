// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The order the process goes down in, as one testable thing (#40).
 *
 * This used to be three statements inside the server-assembly closure, which
 * needs a database, a Redis and a listening socket to construct — so nothing
 * could reach it, and all three could be deleted with the whole suite green.
 * The order is the entire content of this step, and an order nothing checks is
 * an order that drifts.
 *
 * WHY THIS ORDER.
 *
 *   mark shutting down   flips the gate to disk-before-database and makes the
 *                        one attempt per document hold across both paths, so
 *                        the ordinary unload that `closeConnections()` is about
 *                        to trigger settles the same way this walk would.
 *   close connections    stops the typing. `httpServer.close()` in the entry
 *                        only refuses NEW connections — Node keeps established
 *                        sockets open — so without this the snapshot below is
 *                        taken while somebody is still editing, and whatever
 *                        they type between it and `server.destroy()` is
 *                        destroyed with no store, no rescue file and no log
 *                        line. A settle that is not final is not a settle.
 *   settle everything    one final attempt per document, each waited out.
 *
 * WHAT IT DOES NOT COVER, stated rather than papered over: an update relayed
 * from another instance. The Redis extension applies those from its own
 * subscription, which does not care whether this instance has a client, and
 * that connection closes later, in the drains. One arriving after the snapshot
 * is not in what we settle — and is not lost, because under the decided
 * multi-instance model the instance it came FROM holds it and stores its own
 * copy. Pretending to handle it here would be worse than saying so.
 */

import type { UnloadGate, UnloadPayload } from "@collab/hooks/unload-gate.js";

/** Collaborators the shutdown settle needs. */
export interface ShutdownSettleDeps {
  /** The unload gate, which owns what one final attempt means. */
  gate: Pick<UnloadGate, "markShuttingDown" | "settleAllForShutdown">;
  /** Close every client socket, so nothing can be typed into the snapshot. */
  closeConnections(): void;
  /** Every document the instance holds, read AFTER the connections are closed. */
  listDocuments(): Iterable<UnloadPayload>;
}

/**
 * Settle every document the instance still holds, on the way out.
 *
 * Waited for in full, and NOTHING bounds it. This phase is a set of stores, and
 * a store either lands or it does not; a deadline over them cancels nothing, so
 * cutting the phase short only stops this side listening while the writes carry
 * on regardless.
 *
 * What makes that safe is not a fallback elsewhere — be precise, because the
 * first version of this comment pointed at `runGracefulShutdown` and that was
 * wrong twice over: the entry awaits this phase BEFORE calling it, and its
 * deadline races only the drains array it is handed. What makes it safe is the
 * ORDER inside the settle: each document's rescue file is written before its
 * store is attempted, so the content is already on disk before anything slow
 * can happen. A deadline here would buy exiting sooner at the price of
 * abandoning writes that were about to land.
 * @param deps - The gate, the connection close, and the document source.
 * @returns Resolves once every document has been settled.
 */
export async function settleEverythingForShutdown(deps: ShutdownSettleDeps): Promise<void> {
  deps.gate.markShuttingDown();
  deps.closeConnections();
  await deps.gate.settleAllForShutdown(deps.listDocuments());
}
