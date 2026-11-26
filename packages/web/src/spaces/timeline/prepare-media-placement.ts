// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as Y from 'yjs';
import type { ProjectRegisteredAsset } from '@breatic/shared';
import { assetNameFromUrl, durationToFrames } from '@breatic/shared';
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
      // The picked list item's address and media facts, as a canvas node stores them (inner#2171 design §4).
      source: {
        id: input.sourceId, kind: 'video', url: asset.fileUrl, coverUrl: asset.coverUrl,
        name: timelineSourceName(timelineVideoName(asset)), mimeType: asset.mimeType, width: asset.width, height: asset.height,
        timebase: current.settings.fps, extentFrames, durationSeconds: String(duration),
        durationOrigin: asset.durationSeconds === null ? 'decoded' : 'registered',
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

/**
 * What a Project video is called in the Timeline, in its list and on its clip alike: its display name, else the file
 * name its address ends in.
 * @param asset - The listed video.
 * @param asset.displayName - Its display name, which may be missing or empty.
 * @param asset.fileUrl - Its address.
 * @returns The name, or null when neither gives one.
 * @throws {never} Never.
 */
export function timelineVideoName(asset: { displayName: string | null; fileUrl: string }): string | null {
  return asset.displayName || assetNameFromUrl(asset.fileUrl);
}

/**
 * The name a Timeline video source or upload carries: within the schema's 255 characters, `video` when there is none.
 * @param name - The display name, file name or name read off the address.
 * @returns The name to store.
 * @throws {never} Never.
 */
export function timelineSourceName(name: string | null): string {
  return (name ?? '').slice(0, 255) || 'video';
}
