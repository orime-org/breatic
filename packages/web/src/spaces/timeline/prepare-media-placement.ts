// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from 'yjs';
import type { ProjectRegisteredAsset, TimelineEditCommand } from '@breatic/shared';
import { durationToFrames, prepareTimelineEdit, readTimelineDocument, TimelineEditCommandSchema } from '@breatic/shared';

/** A user-confirmed placement draft whose track, frame and identities stay fixed. */
export interface TimelineMediaPlacementInput {
  asset: ProjectRegisteredAsset | null;
  trackId: string;
  startFrame: number;
  clipId: string;
  sourceId: string;
  canWrite: boolean;
  decodedDurationSeconds?: number;
}

/** A prepared immutable edit or a refusal that leaves the draft available. */
export type TimelineMediaPlacementResult = { ok: true; command: TimelineEditCommand }
  | { ok: false; reason: 'readonly' | 'source_unavailable' | 'metadata_unavailable' | 'invalid_range' | 'overlap' | 'target_missing' };

/**
 * Prepare a fixed registered-video placement without accepting an edit.
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
  if (current.clips[input.clipId] !== undefined) return { ok: false, reason: 'target_missing' };
  let extentFrames: number;
  try {
    extentFrames = durationToFrames(duration, current.settings.fps);
  } catch {
    return { ok: false, reason: 'invalid_range' };
  }
  const parsed = TimelineEditCommandSchema.safeParse({
    operation: 'add_video',
    parameters: {
      source: {
        id: input.sourceId, kind: 'video', assetId: asset.assetId, timebase: current.settings.fps,
        extentFrames, durationSeconds: String(duration), durationOrigin: asset.durationSeconds === null ? 'decoded' : 'registered',
      },
      clip: {
        id: input.clipId, kind: 'video', trackId: input.trackId, sourceId: input.sourceId,
        startFrame: input.startFrame, sourceInFrame: 0, durationFrames: extentFrames,
        rate: { num: 1, den: 1 }, gain: 1, mute: false,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      },
    },
  });
  if (!parsed.success) return { ok: false, reason: 'invalid_range' };
  const prepared = prepareTimelineEdit(doc, parsed.data);
  if (prepared.reason !== undefined) return { ok: false, reason: prepared.reason };
  return { ok: true, command: parsed.data };
}
