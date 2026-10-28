// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from 'yjs';

import type {
  DocumentBodyFailure,
  DocumentBodyRuntime,
  DocumentBodyRuntimeSnapshot,
} from '@web/spaces/document/document-body-runtime-types';

/** Shared immutable snapshots keep unchanged external-store reads referentially stable. */
const EMPTY_MISSING: readonly string[] = Object.freeze([]);
const ACTIVE: DocumentBodyRuntimeSnapshot = Object.freeze({
  status: 'active',
  missing: EMPTY_MISSING,
  failure: null,
});
const DISPOSED: DocumentBodyRuntimeSnapshot = Object.freeze({
  status: 'disposed',
  missing: EMPTY_MISSING,
  failure: null,
});

/**
 * Owns the state, source revision and final write admission of one document handle.
 * @param doc - The source document whose updates invalidate prepared batches.
 * @param reportDiagnostic - The application's reporter for callback and subsequent errors.
 * @returns One runtime with a distinct in-memory incarnation.
 * @throws {never} Callback errors are isolated from source updates and state publication.
 */
export function createDocumentBodyRuntime(
  doc: Y.Doc,
  reportDiagnostic: (error: unknown) => void,
): DocumentBodyRuntime {
  const incarnation = Symbol('document-body-runtime');
  const listeners = new Set<() => void>();
  let snapshot = ACTIVE;
  let sourceRevision = 0;

  /**
   * Records a callback error while keeping publication available to other subscribers.
   * @param error - The original callback or subsequent binding error.
   * @throws {never} A reporter failure is recorded at the application boundary.
   */
  function report(error: unknown): void {
    try {
      reportDiagnostic(error);
    } catch (reportingError) {
      console.error('document_body_diagnostic_failed', reportingError);
    }
  }

  /**
   * Publishes the already-latched state to the current subscribers.
   * @throws {never}
   */
  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        report(error);
      }
    }
  }

  /**
   * Counts every actual source update, including deletion-only updates.
   * @throws {never}
   */
  function sourceChanged(): void {
    sourceRevision += 1;
  }

  /**
   * Returns the current stable subscription snapshot.
   * @returns The immutable runtime snapshot.
   * @throws {never}
   */
  function read(): DocumentBodyRuntimeSnapshot {
    return snapshot;
  }

  /**
   * Subscribes to runtime state changes for the current handle lifetime.
   * @param listener - Called after a new state has been installed.
   * @returns An idempotent subscription release.
   * @throws {never}
   */
  function subscribe(listener: () => void): () => void {
    if (snapshot.status !== 'disposed') listeners.add(listener);
    return (): void => {
      listeners.delete(listener);
    };
  }

  /**
   * Pauses projection writes while the latest shared dependency set is incomplete.
   * @param missing - Identities required by the current source projection.
   * @throws {never}
   */
  function wait(missing: readonly string[]): void {
    if (snapshot.status !== 'active' && snapshot.status !== 'waiting') return;
    const currentMissing = [...new Set(missing)].sort();
    if (
      snapshot.status === 'waiting' &&
      currentMissing.length === snapshot.missing.length &&
      currentMissing.every((id, index) => id === snapshot.missing[index])
    ) return;
    snapshot = Object.freeze({
      status: 'waiting',
      missing: Object.freeze(currentMissing),
      failure: null,
    });
    notify();
  }

  /**
   * Resumes a waiting handle after its complete projection has been published.
   * @throws {never}
   */
  function resume(): void {
    if (snapshot.status !== 'waiting') return;
    snapshot = ACTIVE;
    notify();
  }

  /**
   * Latches the first failure before subscribers can synchronously reenter a writer.
   * @param failure - Original error, phase and accepted/last-good recovery references.
   * @throws {never}
   */
  function fail(failure: DocumentBodyFailure): void {
    if (snapshot.status === 'disposed') return;
    if (snapshot.status === 'failed') {
      report(failure.error);
      return;
    }
    snapshot = Object.freeze({ status: 'failed', missing: EMPTY_MISSING, failure });
    notify();
  }

  /**
   * Releases this handle's source listeners, subscribers and recovery references.
   * @throws {never}
   */
  function dispose(): void {
    if (snapshot.status === 'disposed') return;
    doc.off('update', sourceChanged);
    doc.off('destroy', dispose);
    snapshot = DISPOSED;
    notify();
    listeners.clear();
  }

  /**
   * Checks the final permission, incarnation and runtime part of write admission.
   * @param permission - The current product permission for this exact mutation.
   * @param expectedIncarnation - The handle captured by the operation owner.
   * @returns Whether this handle can accept the operation's shared write.
   * @throws {never}
   */
  function canWrite(permission: boolean, expectedIncarnation: symbol): boolean {
    return permission && expectedIncarnation === incarnation && snapshot.status === 'active';
  }

  /**
   * Returns the actual update count for prepared-batch revision checks.
   * @returns The number of source updates observed in this handle lifetime.
   * @throws {never}
   */
  function revision(): number {
    return sourceRevision;
  }

  doc.on('update', sourceChanged);
  doc.on('destroy', dispose);
  return Object.freeze({ incarnation, read, subscribe, wait, resume, fail, dispose, canWrite, revision });
}
