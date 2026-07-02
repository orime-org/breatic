// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Handling-lease sweeper (#1569).
 *
 * `state: 'handling'` is fragile shared state: the driver advancing it
 * (a user's browser for uploads, a Worker for AIGC) can die silently, and
 * the disconnect-event fast path that normally cleans up after a closed
 * tab can itself be lost (collab restart drops every pending disconnect
 * event; a worker judged dead by BullMQ never runs its own write-back).
 * The lease is the correctness guarantee the events cannot give: every
 * handling node carries `handlingBy.startedAt`, and any node still
 * handling more than HANDLING_TIMEOUT_MS (unified 1h fixed budget, user
 * decision 2026-07-02) after that is reclaimed here — regardless of what
 * happened to its driver. Industry-standard shape: events accelerate,
 * timeouts guarantee (Yjs awareness protocol, BullMQ stalled checker,
 * SQS visibility timeout all converge on this).
 *
 * WHERE it runs: collab is the only backend process that can write Yjs
 * canvas state. Two triggers, both using DIRECT document references —
 * deliberately never `openDirectConnection` (#1567 verified that pattern
 * safe from onDisconnect but it DEADLOCKS from load hooks; the sweeper's
 * load trigger runs inside afterLoadDocument, so direct references are
 * the only correct choice here):
 *
 *   1. Document load (`afterLoadDocument` wiring in hocuspocus.ts): a
 *      cold doc's zombies are invisible until someone opens it — sweep
 *      at the moment it loads.
 *   2. Periodic scan (default every 5 min) over the currently-loaded
 *      docs (`hocuspocus.documents`), for docs that stay open long-term.
 *
 * A handling node with NO `handlingBy` at all is reclaimed immediately:
 * after #1569 every live producer writes the lease, so a missing lease
 * is by definition an orphan (pre-#1569 zombie or a torn write).
 *
 * Writes use the {@link HANDLING_SWEEP_ORIGIN} named transaction origin so
 * client UndoManagers (which track only their own origins) never absorb a
 * sweep into a user's undo stack — same convention as `node-state-update`
 * and `collab-disconnect-cleanup`.
 */
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { HANDLING_TIMEOUT_MS, parseDocName } from "@breatic/shared";
import type { HandlingActor, HandlingPhase } from "@breatic/shared";

/** Named transaction origin for sweep write-backs (undo-stack exclusion). */
export const HANDLING_SWEEP_ORIGIN = "handling-lease-sweep";

/** Per-phase / per-operation lease budgets (#1580 #2), from collab.yaml. */
export interface LeaseBudgets {
  /** Default budget (ms) — used for the queue phase and un-overridden ops. */
  defaultBudgetMs: number;
  /** Execution-phase budget (ms) overrides keyed by node `data.operation`. */
  overrides: Record<string, number>;
}

/**
 * Resolve the lease budget (ms) for one handling node (#1580 #2). A backend
 * op has two phases, each measured against its own budget window (the lease
 * is re-stamped at the queue→running transition):
 *   - `running` (execution) may use a per-operation override for genuinely
 *     long ops (e.g. video export) so the sweeper does not kill a live job;
 *   - `queued` / absent always uses the default — queue backlog is
 *     operation-independent.
 * @param phase - The handling lifecycle phase.
 * @param operation - The node's `data.operation` (used only when running).
 * @param budgets - Configured default + per-operation overrides.
 * @returns the budget in ms for this node.
 */
export function resolveLeaseBudget(
  phase: HandlingPhase | undefined,
  operation: string | undefined,
  budgets: LeaseBudgets,
): number {
  if (phase === "running" && operation !== undefined) {
    const override = budgets.overrides[operation];
    if (override !== undefined) return override;
  }
  return budgets.defaultBudgetMs;
}

/**
 * Budget resolver signature used by {@link sweepDoc}. The default (when a
 * caller passes none) is the unified 1h budget for every phase / operation.
 */
export type ResolveBudget = (
  phase: HandlingPhase | undefined,
  operation: string | undefined,
) => number;

/**
 * Default period of the loaded-docs scan (ms). The budget is 1h; 5 min
 * scan granularity keeps worst-case zombie lifetime ~= budget + 5 min.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 300_000;

/** Options for {@link createHandlingSweeper}. */
export interface CreateHandlingSweeperOptions {
  /** Hocuspocus instance whose loaded `documents` the periodic scan walks. */
  hocuspocus: Hocuspocus;
  /** Scan period in ms (default 300_000). */
  intervalMs?: number;
  /** Clock, injectable for tests (default `Date.now`). */
  now?: () => number;
  /**
   * Per-phase / per-operation lease budgets (#1580 #2, from collab.yaml).
   * Omitted → the unified 1h budget for every node.
   */
  budgets?: LeaseBudgets;
}

/** Periodic handling-lease sweeper over the loaded docs. */
export interface HandlingSweeper {
  /**
   * Sweep every currently-loaded canvas doc once.
   * @returns the number of nodes reclaimed across all docs.
   */
  sweepAll(): number;
  /** Start the periodic scan (idempotent). */
  start(): void;
  /** Stop the periodic scan. */
  stop(): void;
}

/**
 * Reclaim every expired handling node in one canvas doc — and, first,
 * server-normalize any frontend lease not yet stamped with the server clock.
 *
 * `startedAt` from a `frontend` driver is BROWSER-authored and must never be
 * compared against the server clock (#1580 #1) — a user's clock that is fast
 * makes `now - startedAt` negative (immortal zombie), one that is slow makes
 * a live upload look expired. So on FIRST observation the sweep overwrites a
 * frontend lease's `startedAt` with the server clock (`now`) and flags
 * `serverStamped`; only a server-stamped (or `backend`, already server-
 * authored at enqueue) lease is evaluated for expiry. A normalized node is
 * NOT reclaimed that pass — its lease now starts from server `now`.
 *
 * A node is then expired when `state === 'handling'` AND (its lease start is
 * older than {@link HANDLING_TIMEOUT_MS} OR it carries no `handlingBy` /
 * `startedAt` at all — an orphan by definition, see module doc). Reclaim
 * = `state: 'idle'` + `errorMessage: 'Operation timed out'` + delete
 * `handlingBy`, the same failure shape every other write-back uses (no
 * third wire state). Both writes use {@link HANDLING_SWEEP_ORIGIN}.
 * @param doc - The canvas Y.Doc (direct reference — never a fresh connection).
 * @param now - Current server time (epoch ms).
 * @param resolveBudget - Budget (ms) for a node given its phase + operation
 *   (#1580 #2). Defaults to the unified 1h for every node.
 * @returns the number of nodes RECLAIMED (normalization is not a reclaim).
 */
export function sweepDoc(
  doc: Y.Doc,
  now: number,
  resolveBudget: ResolveBudget = () => HANDLING_TIMEOUT_MS,
): number {
  const nodesMap = doc.getMap<Y.Map<unknown>>("nodesMap");
  const toNormalize: Y.Map<unknown>[] = [];
  const expired: Y.Map<unknown>[] = [];
  nodesMap.forEach((node) => {
    if (!(node instanceof Y.Map)) return;
    const data = node.get("data");
    if (!(data instanceof Y.Map)) return;
    if (data.get("state") !== "handling") return;
    const handlingBy = data.get("handlingBy") as HandlingActor | undefined;
    // Frontend lease not yet server-stamped → normalize this pass, do not
    // evaluate its (browser-authored) startedAt for expiry.
    if (handlingBy?.type === "frontend" && !handlingBy.serverStamped) {
      toNormalize.push(data);
      return;
    }
    const startedAt = handlingBy?.startedAt;
    const operation = data.get("operation") as string | undefined;
    const budget = resolveBudget(handlingBy?.phase, operation);
    // `>` boundary — the same comparison the web display fallback uses.
    const leaseExpired = startedAt === undefined || now - startedAt > budget;
    if (leaseExpired) expired.push(data);
  });
  if (toNormalize.length === 0 && expired.length === 0) return 0;
  doc.transact(() => {
    for (const data of toNormalize) {
      const hb = data.get("handlingBy") as HandlingActor;
      // Overwrite the browser-authored startedAt with the server clock and
      // flag it so this normalization happens exactly once (the flag persists
      // in the doc across collab restarts).
      data.set("handlingBy", { ...hb, startedAt: now, serverStamped: true });
    }
    for (const data of expired) {
      data.set("state", "idle");
      data.set("errorMessage", "Operation timed out");
      data.delete("handlingBy");
    }
  }, HANDLING_SWEEP_ORIGIN);
  return expired.length;
}

/**
 * Build the periodic sweeper over the Hocuspocus instance's loaded docs.
 * @param options - See {@link CreateHandlingSweeperOptions}.
 * @returns a {@link HandlingSweeper}.
 */
export function createHandlingSweeper(
  options: CreateHandlingSweeperOptions,
): HandlingSweeper {
  const {
    hocuspocus,
    intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    now = Date.now,
    budgets,
  } = options;

  const resolveBudget: ResolveBudget = budgets
    ? (phase, operation): number => resolveLeaseBudget(phase, operation, budgets)
    : (): number => HANDLING_TIMEOUT_MS;

  let timer: ReturnType<typeof setInterval> | null = null;

  const api: HandlingSweeper = {
    sweepAll(): number {
      let total = 0;
      const t = now();
      hocuspocus.documents.forEach((doc, documentName) => {
        // Guard on the doc NAME (same policy split as connection
        // tracking): only Space canvas docs carry a nodesMap contract.
        // Meta docs / the healthz sentinel are never touched even if
        // they pathologically contained a map with that key.
        const parsed = parseDocName(documentName);
        if (!parsed || parsed.kind !== "canvas") return;
        total += sweepDoc(doc, t, resolveBudget);
      });
      return total;
    },
    start(): void {
      if (timer) return;
      // Call through `api` so tests can spy on sweepAll.
      timer = setInterval(() => void api.sweepAll(), intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
  return api;
}
