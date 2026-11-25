// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Mixed-media fixtures for the web Timeline tests (inner#1709 design §2): picture, sound and text clips, the picture and
 * sound sources they name, upload placeholders that name what they become, the version 3 document that holds them and
 * the commands that place and change them (design §3.2).
 *
 * The documents are plain objects shaped as design §2 writes them: tracks are `{ id, order }` with no kind, and
 * `sources` is the discriminated union of video, image and audio. They are not passed through a schema, since the
 * shared schema of version 3 is written beside this task.
 */

import type {
  TimelineClip, TimelineDocumentV1, TimelineTrack, TimelineVideoClip, TimelineVideoSource,
} from '@breatic/shared';

import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { FPS, SETTINGS, SOURCE } from '@web/data/yjs/__tests__/timeline-document-fixtures';

/** A registered picture (design §2.2): it has no length of its own. */
export interface ImageSource { id: string; kind: 'image'; assetId: string; width: number | null; height: number | null }

/** A registered sound (design §2.2), measured like a video. */
export type AudioSource = Omit<TimelineVideoSource, 'kind'> & { kind: 'audio' };

/** Any source of a version 3 document. */
export type MediaSource = TimelineVideoSource | ImageSource | AudioSource;

/** A placement of a picture (design §2.3). */
export type ImageClip = Omit<TimelineVideoClip, 'kind'> & { kind: 'image' };

/** A placement of a sound (design §2.3). */
export type AudioClip = Omit<TimelineVideoClip, 'kind'> & { kind: 'audio' };

/** A text label (design §2.3). */
export type TextClip = Omit<TimelineVideoClip, 'kind' | 'sourceId'> & { kind: 'text'; text: { body: string; size: number } };

/** An upload placeholder that names what it becomes (design §2.3). */
export type MediaUploadClip = Omit<TimelineVideoClip, 'kind' | 'sourceId'> & {
  kind: 'upload';
  upload: { uploadId: string; name: string; kind: 'video' | 'image' | 'audio'; durationSeconds: number | null; state?: 'processing' | 'failed' };
};

/** Any clip of a version 3 document. */
export type MediaClip = TimelineClip | ImageClip | AudioClip | TextClip | MediaUploadClip;

/** `10^(12/20)`, +12 dB (design §2.3), written out so the expectation is not read from the code under test. */
export const MAX_GAIN = 10 ** (12 / 20);

/** A 1080 x 1920 picture. */
export const IMAGE: ImageSource = {
  id: '10000000-0000-4000-8000-0000000000e1', kind: 'image', assetId: '20000000-0000-4000-8000-0000000000e1', width: 1080, height: 1920,
};

/** 120 frames at 24 fps of sound. */
export const AUDIO: AudioSource = {
  id: '10000000-0000-4000-8000-0000000000a5', kind: 'audio', assetId: '20000000-0000-4000-8000-0000000000a5',
  timebase: FPS, extentFrames: 120, durationSeconds: '5', durationOrigin: 'registered',
};

const PLACEMENT = {
  sourceInFrame: 0,
  rate: { num: 1, den: 1 },
  gain: 1,
  mute: false,
  transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
} as const;

/**
 * A picture clip of `IMAGE`.
 * @param id - The clip id.
 * @param trackId - Its track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length.
 * @param fields - Overrides.
 * @returns The clip.
 * @throws {never} Never.
 */
export function imageClip(id: string, trackId: string, startFrame: number, durationFrames: number, fields: Partial<ImageClip> = {}): ImageClip {
  return { id, trackId, kind: 'image', sourceId: IMAGE.id, startFrame, durationFrames, ...structuredClone(PLACEMENT), ...fields };
}

/**
 * A sound clip of `AUDIO`.
 * @param id - The clip id.
 * @param trackId - Its track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length.
 * @param fields - Overrides.
 * @returns The clip.
 * @throws {never} Never.
 */
export function audioClip(id: string, trackId: string, startFrame: number, durationFrames: number, fields: Partial<AudioClip> = {}): AudioClip {
  return { id, trackId, kind: 'audio', sourceId: AUDIO.id, startFrame, durationFrames, ...structuredClone(PLACEMENT), ...fields };
}

/**
 * A text clip.
 * @param id - The clip id.
 * @param trackId - Its track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length.
 * @param fields - Overrides such as `text`.
 * @returns The clip.
 * @throws {never} Never.
 */
export function textClip(id: string, trackId: string, startFrame: number, durationFrames: number, fields: Partial<TextClip> = {}): TextClip {
  return { id, trackId, kind: 'text', text: { body: 'Title', size: 0.06 }, startFrame, durationFrames, ...structuredClone(PLACEMENT), ...fields };
}

/**
 * An upload placeholder of the given kind.
 * @param id - The clip id.
 * @param trackId - Its track.
 * @param startFrame - Its timeline start.
 * @param durationFrames - Its length.
 * @param kind - What it becomes.
 * @param fields - Overrides.
 * @returns The placeholder; a picture's has no duration, a video's or sound's lasts 2.5 s.
 * @throws {never} Never.
 */
export function mediaUpload(
  id: string, trackId: string, startFrame: number, durationFrames: number, kind: 'video' | 'image' | 'audio', fields: Partial<MediaUploadClip> = {},
): MediaUploadClip {
  return {
    id, trackId, kind: 'upload',
    upload: { uploadId: 'b0000000-0000-4000-8000-000000000011', name: `upload.${kind}`, kind, durationSeconds: kind === 'image' ? null : 2.5 },
    startFrame, durationFrames, ...structuredClone(PLACEMENT), ...fields,
  };
}

/**
 * A track as version 3 stores it: an id and an order, no kind (design §3.1).
 * @param id - The track id.
 * @param order - Its stacking order.
 * @returns The track.
 * @throws {never} Never.
 */
export function plainTrack(id: string, order: number): TimelineTrack {
  return { id, order } as TimelineTrack;
}

/**
 * A version 3 document of any clips and sources, unvalidated.
 * @param clips - The clips.
 * @param tracks - The tracks.
 * @param sources - The sources; `SOURCE`, `IMAGE` and `AUDIO` by default.
 * @returns The document.
 * @throws {never} Never.
 */
export function mixedTimeline(
  clips: readonly MediaClip[], tracks: readonly TimelineTrack[], sources: readonly MediaSource[] = [SOURCE, IMAGE, AUDIO],
): TimelineDocumentV1 {
  return {
    schemaVersion: 3,
    settings: SETTINGS,
    tracks: Object.fromEntries(tracks.map((item) => [item.id, item])),
    clips: Object.fromEntries(clips.map((item) => [item.id, item])),
    sources: Object.fromEntries(sources.map((item) => [item.id, item])),
  } as unknown as TimelineDocumentV1;
}

/**
 * `add_media` (design §3.2): place a registered video, picture or sound, writing its source when the document lacks it.
 * @param source - The source.
 * @param clip - The clip.
 * @param placement - The editing user's switches.
 * @param newTrackId - A new top track to place it on.
 * @returns The command.
 * @throws {never} Never.
 */
export function addMedia(source: MediaSource, clip: MediaClip, placement: TimelineEditPlacement, newTrackId?: string): TimelineEditCommand {
  return { operation: 'add_media', parameters: { source, clip, ...(newTrackId === undefined ? {} : { newTrackId }) }, placement } as unknown as TimelineEditCommand;
}

/**
 * `add_text` (design §3.2).
 * @param clipId - The new clip's id.
 * @param startFrame - Where it starts.
 * @param newTrackId - The id a new top track would take.
 * @param durationFrames - Its length.
 * @param placement - The editing user's switches.
 * @param text - Its words and size.
 * @returns The command.
 * @throws {never} Never.
 */
export function addText(
  clipId: string, startFrame: number, newTrackId: string, durationFrames: number, placement: TimelineEditPlacement,
  text: { body: string; size: number } = { body: 'Default text', size: 0.06 },
): TimelineEditCommand {
  return { operation: 'add_text', parameters: { clipId, startFrame, newTrackId, text, durationFrames }, placement } as unknown as TimelineEditCommand;
}

/**
 * `set_text` (design §3.2).
 * @param clipId - The text clip.
 * @param text - Its new words and size.
 * @param placement - The editing user's switches.
 * @returns The command.
 * @throws {never} Never.
 */
export function setText(clipId: string, text: { body: string; size: number }, placement: TimelineEditPlacement): TimelineEditCommand {
  return { operation: 'set_text', parameters: { clipId, text }, placement } as unknown as TimelineEditCommand;
}

/**
 * `set_audio` (design §3.2).
 * @param clipId - The video or sound clip.
 * @param gain - Its linear gain.
 * @param mute - Whether it is muted.
 * @param placement - The editing user's switches.
 * @returns The command.
 * @throws {never} Never.
 */
export function setAudio(clipId: string, gain: number, mute: boolean, placement: TimelineEditPlacement): TimelineEditCommand {
  return { operation: 'set_audio', parameters: { clipId, gain, mute }, placement } as unknown as TimelineEditCommand;
}
