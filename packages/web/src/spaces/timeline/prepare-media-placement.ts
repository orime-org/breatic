// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as Y from 'yjs';
import type { ProjectRegisteredAsset, TimelineRate } from '@breatic/shared';
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
  /** How long a new picture lasts, from the Timeline limits (inner#1709). */
  imageDurationSeconds?: number;
}

/** A prepared immutable edit or a refusal that leaves the draft available. */
export type TimelineMediaPlacementResult = { ok: true; command: TimelineEditCommand }
  | { ok: false; reason: 'readonly' | 'metadata_unavailable' | 'source_unavailable' | 'invalid_range' };

/**
 * The frames a duration spans at the Timeline rate, or null when the duration is unusable.
 * @param seconds - The duration.
 * @param fps - The Timeline frame rate.
 * @returns The frames, or null.
 * @throws {never} Never.
 */
function framesOf(seconds: number, fps: TimelineRate): number | null {
  try {
    return durationToFrames(seconds, fps);
  } catch {
    return null;
  }
}

/**
 * Build the native command for a fixed registered video, picture or sound placement; the edit itself validates and
 * plans it (inner#1709). A video or sound lasts its file; a picture lasts the configured picture length.
 * @param doc - The actual current Timeline content document.
 * @param input - The fixed draft and current authority to write.
 * @returns The prepared native command or a recoverable refusal.
 * @throws {Error} When the current document format is unsupported.
 */
export function prepareTimelineMediaPlacement(doc: Y.Doc, input: TimelineMediaPlacementInput): TimelineMediaPlacementResult {
  if (!input.canWrite) return { ok: false, reason: 'readonly' };
  const asset = input.asset;
  if (asset === null || (asset.kind !== 'video' && asset.kind !== 'image' && asset.kind !== 'audio')) return { ok: false, reason: 'source_unavailable' };
  const current = readTimelineDocument(doc);
  const fps = current.settings.fps;
  const newTrack = input.newTrackId === undefined ? {} : { newTrackId: input.newTrackId };
  const placed = { id: input.clipId, trackId: input.trackId, sourceId: input.sourceId, startFrame: input.startFrame, sourceInFrame: 0, ...TIMELINE_DEFAULT_PLACEMENT };
  if (asset.kind === 'image') {
    const seconds = input.imageDurationSeconds;
    if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return { ok: false, reason: 'metadata_unavailable' };
    const durationFrames = framesOf(seconds, fps);
    if (durationFrames === null) return { ok: false, reason: 'invalid_range' };
    return { ok: true, command: {
      operation: 'add_media',
      parameters: {
        source: { id: input.sourceId, kind: 'image', assetId: asset.assetId, width: asset.width, height: asset.height },
        clip: { ...placed, kind: 'image', sourceInFrame: 0, durationFrames },
        ...newTrack,
      },
      placement: input.placement,
    } };
  }
  const duration = asset.durationSeconds === null ? input.decodedDurationSeconds : asset.durationSeconds;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return { ok: false, reason: 'metadata_unavailable' };
  const extentFrames = framesOf(duration, fps);
  if (extentFrames === null) return { ok: false, reason: 'invalid_range' };
  const source = {
    id: input.sourceId, assetId: asset.assetId, timebase: fps, extentFrames, durationSeconds: String(duration),
    durationOrigin: asset.durationSeconds === null ? 'decoded' as const : 'registered' as const,
  };
  const command: TimelineEditCommand = asset.kind === 'video'
    ? { operation: 'add_media', parameters: { source: { ...source, kind: 'video' }, clip: { ...placed, kind: 'video', durationFrames: extentFrames }, ...newTrack }, placement: input.placement }
    : { operation: 'add_media', parameters: { source: { ...source, kind: 'audio' }, clip: { ...placed, kind: 'audio', durationFrames: extentFrames }, ...newTrack }, placement: input.placement };
  return { ok: true, command };
}
