// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The presentation candidate failure classification (frames-split design §10.6 failure classes row).
 */

/** Whether a failure is temporary (a retry may succeed) or decided by the source bytes and the frozen policy. */
export type VideoSourceLedgerFailureClass = 'transient' | 'content';

// Codes the source bytes and the frozen policy decide (§10.6): producing again fails the same way. Every other code
// (`grid_mismatch`, `reuse_source_invalid`, `presentation_invalid`, ...) is transient.
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
