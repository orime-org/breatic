// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Audit facts the operations ledger produces (inner#1968, design 3.2.1).
 *
 * Domain does not log; each service entry subscribes once and writes these
 * as log lines, the same way event-emitter error listeners are attached by
 * the entry. Aggregated per user they show who uploads derived images that
 * nothing uses.
 */

/** One audit fact. */
export type OperationAudit =
  | { msg: "operation_deferred"; userId: string; projectId: string | null; operationKey: string; assetId: string }
  | { msg: "operation_derived_absorbed"; userId: string; projectId: string | null; operationKey: string; assetId: string | null; absorbedBy: string }
  | { msg: "operation_deferred_counted"; userId: string; projectId: string | null; operationKey: string; slot: "allowance" | "overage" };

const listeners = new Set<(audit: OperationAudit) => void>();

/**
 * Subscribe to the ledger's audit facts.
 * @param listener - Called with each fact; it must not throw.
 * @returns A function that unsubscribes.
 */
export function onOperationAudit(listener: (audit: OperationAudit) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Hand facts to every subscriber.
 * @param audits - The facts, in order.
 */
export function emitOperationAudit(audits: readonly OperationAudit[]): void {
  for (const audit of audits) for (const listener of listeners) listener(audit);
}
