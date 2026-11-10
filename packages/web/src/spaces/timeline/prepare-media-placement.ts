// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as Y from 'yjs';
import type { ProjectRegisteredAsset } from '@breatic/shared';
import { durationToFrames } from '@breatic/shared';
import { readTimelineDocument } from '@web/data/yjs/timeline-document';
import { TIMELINE_DEFAULT_PLACEMENT, type TimelineEditCommand, type TimelineEditPlacement } from '@web/data/yjs/timeline-edit';

/** A user-confirmed placement draft whose track, frame and identities stay fixed. */
export interface TimelineMediaPlacementInput {
  asset: ProjectRegisteredAsset | null;
  trackId: string;
  startFrame: number;
  clipId: string;
  sourceId: string;
  canWrite: boolean;
  placement: TimelineEditPlacement;
  newTrackId?: string;
  decodedDurationSeconds?: number;
}

/** A prepared immutable edit or a refusal that leaves the draft available. */
export type TimelineMediaPlacementResult = { ok: true; command: TimelineEditCommand }
  | { ok: false; reason: 'readonly' | 'metadata_unavailable' | 'source_unavailable' | 'invalid_range' };

/**
 * Build the native command for a fixed registered-video placement; the edit itself validates and plans it.
 * @param doc - The actual current Timeline content document.
 * @param input - The fixed draft and current authority to write.
 * @returns The prepared native command or a recoverable refusal.
 * @throws {Error} When the current document format is unsupported.
 */
export function prepareTimelineMediaPlacement(doc: Y.Doc, input: TimelineMediaPlacementInput): TimelineMediaPlacementResult {
  if (!input.canWrite) return { ok: false, reason: 'readonly' };
  const asset = input.asset;
  if (asset === null || asset.kind !== 'video') return { ok: false, reason: 'source_unavailable' };
  const duration = asset.durationSeconds === null ? input.decodedDurationSeconds : asset.durationSeconds;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return { ok: false, reason: 'metadata_unavailable' };
  const current = readTimelineDocument(doc);
  let extentFrames: number;
  try {
    extentFrames = durationToFrames(duration, current.settings.fps);
  } catch {
    return { ok: false, reason: 'invalid_range' };
  }
  const command: TimelineEditCommand = {
    operation: 'add_video',
    parameters: {
      source: {
        id: input.sourceId, kind: 'video', assetId: asset.assetId, timebase: current.settings.fps,
        extentFrames, durationSeconds: String(duration), durationOrigin: asset.durationSeconds === null ? 'decoded' : 'registered',
      },
      clip: {
        id: input.clipId, kind: 'video', trackId: input.trackId, sourceId: input.sourceId,
        startFrame: input.startFrame, sourceInFrame: 0, durationFrames: extentFrames,
        ...TIMELINE_DEFAULT_PLACEMENT,
      },
      ...(input.newTrackId === undefined ? {} : { newTrackId: input.newTrackId }),
    },
    placement: input.placement,
  };
  return { ok: true, command };
}
