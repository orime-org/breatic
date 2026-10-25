// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
/** Geometry and URL of one verified packed-alpha derivative. */
export interface AlphaManifest {
  schemaVersion: 1;
  sourceFingerprint: string;
  packedURL: string;
  packedWidth: number;
  packedHeight: number;
  colorRect: VideoPresentationRect;
  alphaRect: VideoPresentationRect;
}
/** Frozen operational and subprocess ceilings for one auxiliary attempt. */
export interface VideoPresentationProcessLimits {
  maxSourceBytes: number;
  maxPackedBytes: number;
  crf: number;
  preset: string;
  probeStdoutBytes: number;
  analysisStdoutBytes: number;
  stderrTailBytes: number;
}
