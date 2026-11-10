// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Upload placeholders for the web Timeline tests (#1434 design §2): a local video still uploading in the background
 * sits on its track as a `kind: 'upload'` clip, measured against the duration the browser read from the file, until
 * the upload registers and the clip turns into a video clip of the registered asset.
 */

import * as Y from 'yjs';
import type { ProjectRegisteredAsset, TimelineUploadClip } from '@breatic/shared';

import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';

/** The upload every placeholder below belongs to unless a test names another. */
export const UPLOAD_ID = 'b0000000-0000-4000-8000-000000000001';
/** A second, unrelated upload. */
export const OTHER_UPLOAD_ID = 'b0000000-0000-4000-8000-000000000002';
export const UPLOAD_NAME = 'beach.mp4';
/** What the browser read from the file: 2.5 s, 60 frames at 24 fps. */
export const UPLOAD_SECONDS = 2.5;
export const UPLOAD_FRAMES = 60;
/** The asset the upload registers as. */
export const ASSET_ID = '20000000-0000-4000-8000-0000000000a1';

/**
 * A placeholder clip of an upload.
 * @param id - The clip id.
 * @param trackId - Its visual track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length, the whole local duration by default.
 * @param fields - Overrides such as `sourceInFrame` or `upload`.
 * @returns A schema-valid upload clip.
 * @throws {never} Never.
 */
export function uploadClip(
  id: string, trackId: string, startFrame: number, durationFrames = UPLOAD_FRAMES, fields: Partial<TimelineUploadClip> = {},
): TimelineUploadClip {
  return {
    id,
    trackId,
    kind: 'upload',
    upload: { uploadId: UPLOAD_ID, name: UPLOAD_NAME, durationSeconds: UPLOAD_SECONDS },
    startFrame,
    sourceInFrame: 0,
    durationFrames,
    rate: { num: 1, den: 1 },
    gain: 1,
    mute: false,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    ...fields,
  };
}

/**
 * The `add_upload` command the material dialog writes when the user confirms a local video (design §3.2).
 * @param clip - The placeholder.
 * @param placement - The editing user's switches.
 * @param newTrackId - A new top track to place it on instead of `clip.trackId`.
 * @returns The command.
 * @throws {never} Never.
 */
export function addUpload(clip: TimelineUploadClip, placement: TimelineEditPlacement, newTrackId?: string): TimelineEditCommand {
  return {
    operation: 'add_upload',
    parameters: newTrackId === undefined ? { clip } : { clip, newTrackId },
    placement,
  } as unknown as TimelineEditCommand;
}

/**
 * What `timelineApi.resolveAsset` answers for the registered upload.
 * @param durationSeconds - The registered duration; null when the server could not read one.
 * @param fields - Overrides such as `kind`.
 * @returns The asset.
 * @throws {never} Never.
 */
export function registeredVideo(durationSeconds: number | null, fields: Partial<ProjectRegisteredAsset> = {}): ProjectRegisteredAsset {
  return {
    assetId: ASSET_ID,
    projectReferenceId: '20000000-0000-4000-8000-0000000000b1',
    displayName: UPLOAD_NAME,
    kind: 'video',
    fileUrl: 'https://cdn.example/beach.mp4',
    coverUrl: null,
    width: 1920,
    height: 1080,
    durationSeconds,
    mimeType: 'video/mp4',
    sizeBytes: 1024,
    ...fields,
  };
}

/**
 * Every clip record of a document as JSON, damaged ones included.
 * @param doc - The document.
 * @returns The records by id.
 * @throws {never} Never.
 */
export function clipRecords(doc: Y.Doc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  doc.getMap<unknown>('clips').forEach((value, id) => { out[id] = value instanceof Y.Map ? value.toJSON() : value; });
  return out;
}
