// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation candidate failure classification (frames-split design §10.6 failure classes row). The frame-table companion
 * this module once held is gone; the classifier keeps its name and module path because callers and tests read it here.
 */

/** Whether a failure is temporary (a retry may succeed) or decided by the source bytes and the frozen policy. */
export type VideoSourceLedgerFailureClass = 'transient' | 'content';

// Codes the source bytes and the frozen policy decide: producing again fails the same way. Limits frozen at admission
// (`resource_limit`) are content; real exhaustion is the transient `resource_exhausted`. Every other code, the
// listed temporary ones (`grid_mismatch`, `reuse_source_invalid`, `presentation_invalid`, ...) included, is transient.
const CONTENT_FAILURES: ReadonlySet<string> = new Set([
  'classification_unknown', 'probe_invalid', 'source_over_cap', 'no_presented_frames', 'resource_limit', 'too_long', 'packed_over_cap', 'edit_over_cap',
]);

/**
 * Classify a presentation candidate failure code; every code outside the content list is transient.
 * @param errorCode - The producer's or the store's failure code.
 * @returns `content` when the source bytes decide the failure, otherwise `transient`.
 * @throws {never} Never.
 */
export function classifyVideoSourceLedgerFailure(errorCode: string): VideoSourceLedgerFailureClass {
  return CONTENT_FAILURES.has(errorCode) ? 'content' : 'transient';
}
