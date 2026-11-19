// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolPlanTarget } from '@shared/upload/mini-tool-plan-types.js';

/** Known registered constraints remain present while other source facts are unknown. */
export interface VideoPresentationRegisteredMetadata { width: number | null; height: number | null; duration: number | null }

/** Owned pixel rectangle, independent of renderer configuration. */
export interface VideoPresentationRect { x: number; y: number; width: number; height: number }
/** Owned canonical classification and presentation readiness. */
export interface VideoPresentation {
  schemaVersion: 1;
  sourceFingerprint: string;
  original: { width: number; height: number; duration: number };
  state: 'classifying' | 'native' | 'alpha_pending' | 'alpha_ready' | 'failed';
  alpha?: { manifestURL: string };
  attempt?: { jobId: string; deadlineAt: number };
  error?: string;
}
/** Frozen operational and subprocess ceilings for one auxiliary attempt. */
export interface VideoPresentationProcessLimits {
  maxSourceBytes: number;
  maxPackedBytes: number;
  crf: number;
  preset: MiniToolPlanTarget['preset'];
  probeStdoutBytes: number;
  analysisStdoutBytes: number;
  stderrTailBytes: number;
}
