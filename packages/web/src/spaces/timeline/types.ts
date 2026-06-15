// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { Modality } from '@web/spaces/canvas/types/node-view';

/**
 * Timeline data primitives — placeholders for the M3+ rebuild. The full
 * editor will be canvas-native (built on top of the same node primitives
 * as the Canvas space) per the V1-removed direction, so these types are
 * intentionally narrow.
 */

export interface TimelineClip {
  id: string;
  modality: Modality;
  /** Start time in milliseconds along the timeline. */
  startMs: number;
  /** Clip duration in milliseconds. */
  durationMs: number;
  /** Display label (filename, snippet, etc.). */
  label: string;
}

export interface TimelineTrack {
  id: string;
  name: string;
  modality: Modality;
  clips: ReadonlyArray<TimelineClip>;
}
