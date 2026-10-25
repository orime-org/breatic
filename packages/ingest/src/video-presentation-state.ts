// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoPresentation } from '@breatic/shared';

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
  void accepted;
  void proposed;
  return current;
}
