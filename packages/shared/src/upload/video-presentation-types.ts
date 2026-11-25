// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolPlanTarget } from '@shared/upload/mini-tool-plan-types.js';

/** Known registered constraints remain present while other source facts are unknown. */
export interface VideoPresentationRegisteredMetadata { width: number | null; height: number | null; duration: number | null }

/** Owned pixel rectangle, independent of renderer configuration. */
export interface VideoPresentationRect { x: number; y: number; width: number; height: number }
/** The original's registered display size and duration. */
export interface VideoPresentationOriginal { width: number; height: number; duration: number }
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
