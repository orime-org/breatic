// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** The lifetime state held by one mounted document handle. */
export type DocumentBodyRuntimeStatus = 'active' | 'waiting' | 'failed' | 'disposed';

/** The original operation and recovery references retained after a binding failure. */
export interface DocumentBodyFailure {
  readonly phase: string;
  readonly error: Error;
  readonly batch: string | null;
  readonly epoch: number;
  readonly accepted: unknown;
  readonly selection: unknown;
  readonly journal: unknown;
  readonly lastGood: unknown;
  readonly writeStarted: boolean;
  readonly writeReturned: boolean;
}

/** A stable subscription snapshot of the current handle state. */
export interface DocumentBodyRuntimeSnapshot {
  readonly status: DocumentBodyRuntimeStatus;
  readonly missing: readonly string[];
  readonly failure: DocumentBodyFailure | null;
}

/** The synchronous state and admission contract shared by one document handle. */
export interface DocumentBodyRuntime {
  readonly incarnation: symbol;
  readonly read: () => DocumentBodyRuntimeSnapshot;
  /** Input capture runs after state latching and before readonly/presentation listeners. */
  readonly subscribe: (listener: () => void, options?: { readonly captureInput?: boolean }) => () => void;
  readonly wait: (missing: readonly string[]) => void;
  readonly resume: () => void;
  readonly fail: (failure: DocumentBodyFailure) => void;
  readonly dispose: () => void;
  readonly canWrite: (permission: boolean, incarnation: symbol) => boolean;
  readonly revision: () => number;
}
