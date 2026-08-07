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
 *   settle everything    one final attempt per document, bounded as a phase.
 *
 * WHAT IT DOES NOT COVER, stated rather than papered over: an update relayed
 * from another instance. The Redis extension applies those from its own
 * subscription, which does not care whether this instance has a client, and
 * that connection closes later, in the drains. One arriving after the snapshot
 * is not in what we settle — and is not lost, because under the decided
 * multi-instance model the instance it came FROM holds it and stores its own
 * copy. Pretending to handle it here would be worse than saying so.
 */

import { createLogger } from "@breatic/core";
import type { UnloadGate, UnloadPayload } from "@collab/hooks/unload-gate.js";
import { runWithTimeout } from "@collab/services/with-timeout.js";

const logger = createLogger("collab-shutdown-settle");

/** Collaborators the shutdown settle needs. */
export interface ShutdownSettleDeps {
  /** The unload gate, which owns what one final attempt means. */
  gate: Pick<UnloadGate, "markShuttingDown" | "settleAllForShutdown">;
  /** Close every client socket, so nothing can be typed into the snapshot. */
  closeConnections(): void;
  /** Every document the instance holds, read AFTER the connections are closed. */
  listDocuments(): Iterable<UnloadPayload>;
  /** How long the whole phase gets, across every document at once. */
  budgetMs: number;
}

/**
 * Settle every document the instance still holds, on the way out.
 * @param deps - The gate, the connection close, the document source, the budget.
 * @returns Resolves once every document has been settled or the budget elapsed.
 */
export async function settleEverythingForShutdown(deps: ShutdownSettleDeps): Promise<void> {
  deps.gate.markShuttingDown();
  deps.closeConnections();

  // Bounded as a phase rather than per document. The documents settle
  // concurrently, so a hung database costs one budget, not one per open
  // document — and the process is on a deadline it does not control. The
  // config loader refuses a budget that does not outlast one document's own
  // attempt, which would make this always report itself exhausted.
  const outcome = await runWithTimeout(
    deps.gate.settleAllForShutdown(deps.listDocuments()),
    deps.budgetMs,
  );
  if (outcome.timedOut) {
    logger.error({ budgetMs: deps.budgetMs }, "collab_shutdown_settle_budget_exhausted");
  }
}
