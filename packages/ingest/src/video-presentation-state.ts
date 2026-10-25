// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { parseVideoPresentation, type VideoPresentation } from '@breatic/shared';

/** Internal accepted work identity, including sources not yet measured. */
export interface AcceptedVideoPresentationAttempt {
  sourceFingerprint: string;
  jobId: string;
  deadlineAt: number;
}

/**
 * Check one current attempt's proposed descriptor without changing canonical bytes.
 * @param current - Last committed descriptor, or unknown before measurement.
 * @param accepted - Persisted active auxiliary-work identity.
 * @param proposed - The attempted descriptor write.
 * @returns The next descriptor, or the unchanged prior value for stale writes.
 * @throws {never} Invalid or stale writes leave the prior fact intact.
 */
export function advanceVideoPresentation(
  current: VideoPresentation | null,
  accepted: AcceptedVideoPresentationAttempt,
  proposed: unknown,
): VideoPresentation | null {
  const next = parseVideoPresentation(proposed, accepted.sourceFingerprint);
  if (next === null || next.attempt?.jobId !== accepted.jobId || next.attempt.deadlineAt !== accepted.deadlineAt) return current;
  if (current !== null && current.sourceFingerprint === accepted.sourceFingerprint) {
    for (const field of ['width', 'height', 'duration'] as const) {
      if (current.original[field] !== next.original[field]) return current;
    }
    const transitions: Record<VideoPresentation['state'], readonly VideoPresentation['state'][]> = {
      classifying: ['classifying', 'native', 'alpha_pending', 'failed'],
      native: ['native', 'classifying', 'failed'],
      alpha_pending: ['alpha_pending', 'alpha_ready', 'failed'],
      alpha_ready: ['alpha_ready', 'alpha_pending', 'failed'],
      failed: ['failed', 'classifying', 'alpha_pending', 'alpha_ready'],
    };
    if (!transitions[current.state].includes(next.state)) return current;
  }
  return next;
}
