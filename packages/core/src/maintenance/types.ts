// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Exact, owner-approved physical scope; never expanded by suffix or prefix.
 */
export interface ReclaimScope {
  id: string;
  storageKey: string;
  keptStorageKey: string;
}

/**
 * Runtime capability, independent of the owner's persistent switch.
 */
export interface MaintenanceAvailability {
  enabled: boolean;
  configured: boolean;
  available: boolean;
}

/**
 * Original immutable acceptance/refusal.
 */
export interface ReclaimDecision {
  key: string;
  decision: "accepted" | "refused";
  reason: string | null;
  requestedBy: string;
  decidedAt: string;
}

/**
 * Mutable maintenance switch protected by a revision.
 */
export interface MaintenanceState {
  state: "enabled" | "paused";
  version: number;
  changedBy: string;
  changedAt: string;
  executor: MaintenanceAvailability;
}

/**
 * One attempt's result or one key's most recent physical observation.
 */
export interface ReclaimItemResult {
  id: string;
  storageKey: string;
  state: "queued" | "running" | "missing" | "present" | "unknown" | "conflict" | "failed" | "deferred";
  reason: string | null;
  checkedAt: string | null;
  leaseVersion: number;
}

/**
 * One bounded traversal of the complete approved scope.
 */
export interface ReclaimRun {
  id: string;
  number: number;
  state: "queued" | "running" | "completed" | "partial" | "failed";
  startedAt: string;
  finishedAt: string | null;
  items: ReclaimItemResult[];
}

/**
 * Read model separates original decision, initial progress and later rounds.
 */
export interface ReclaimOperationView {
  decision: ReclaimDecision;
  operation: null | {
    scope: ReclaimScope[];
    firstRun: ReclaimRun | null;
    maintenance: MaintenanceState;
    runs: ReclaimRun[];
    latest: ReclaimItemResult[];
    runsPage?: {
      nextCursor: string | null;
    };
  };
}

/**
 * An independently idempotent control decision.
 */
export interface ReclaimControlDecision {
  key: string;
  operationKey: string;
  decision: "saved" | "refused";
  action: "pause" | "resume";
  state: "enabled" | "paused";
  version: number;
  requestedBy: string;
  decidedAt: string;
  reason: string | null;
}

/**
 * Validated execution settings.
 */
export interface MaintenanceConfig {
  enabled: boolean;
  loopIntervalSeconds: number;
  checkIntervalSeconds: number;
  batchSize: number;
  /** Physical operations in flight; omitted fixture settings retain serial execution. */
  concurrency?: number;
  leaseSeconds: number;
  protectionSeconds: number;
  previewTtlSeconds: number;
  storageTimeoutMs: number;
}
