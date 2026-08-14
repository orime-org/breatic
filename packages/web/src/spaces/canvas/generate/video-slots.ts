// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every source slot the video panel can offer, and everything one is made of.
 *
 * A slot is a pick-time COPY of one asset, with a role: the first frame, the
 * end frame, the character image (which animation drives and the talking head
 * speaks), the driving video motion is taken from, and the driving audio lips
 * follow. It is not a reference — references are a relationship (an edge), a
 * slot is a value.
 *
 * Each slot's facts live here rather than spread across the toolbar, the
 * canvas click handler, the candidate highlighting and the payload builder.
 * That spread is what let the first-frame slot ship telling the user to
 * "select a reference" (#1902): three of those sites were extended and the
 * fourth was not. A slot is one entry here plus the mode options that name it.
 */

import { AudioLines, Image, UserRound, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { PickPurpose } from '@web/stores/canvas';

/** The source slots the video panel knows how to offer. */
export type VideoSlot =
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'drivingAudio';

/** Node data fields a slot's pick is copied into. */
export type VideoSlotField =
  | 'firstFrameUrl'
  | 'endFrameUrl'
  | 'characterImageUrl'
  | 'drivingVideo'
  | 'drivingAudio';

/** What one slot is made of. */
export interface VideoSlotSpec {
  /** Node data field holding this slot's pick — a URL, or `{url, cover}` when `storesCover`. */
  field: VideoSlotField;
  /**
   * Whether this slot stores `{url, cover}` rather than a bare URL string.
   *
   * The toolbar draws a filled slot with an `<img>`, which works only while
   * the picked URL is an image. A video URL there renders nothing — and with
   * `alt=''` not even a broken-image marker, just a blank square. A slot
   * taking anything other than an image copies its node's poster alongside
   * the asset, inside the one field, so the pair converges as a unit.
   */
  storesCover?: true;
  /** The param the URL travels as, under our own names. */
  param: string;
  /** The pick this slot starts; the canvas dispatches on it. */
  purpose: PickPurpose;
  /**
   * The node type this slot takes. Read by both the candidate highlighting
   * and the click that fills the slot, so the two cannot disagree.
   *
   * Narrower than `NodeType` deliberately: what a slot holds is also what its
   * button shows and what its hover preview renders (#1946), and those two can
   * only handle an asset form. Declaring a slot for anything else would fail
   * to type-check here rather than render an empty card at runtime.
   */
  accepts: 'image' | 'video' | 'audio';
  /** Icon shown while the slot is empty. */
  Icon: LucideIcon;
  /** Test id of the slot control. */
  testId: string;
  /** Test id of the filled thumbnail. */
  thumbnailTestId: string;
  /** Test id of the clear badge. */
  clearTestId: string;
  /** Translation key for the slot's label. */
  labelKey: string;
  /** Translation key for the one line saying what to go pick — the slot's hover card carries it as the hint while empty (#1946). */
  tipKey: string;
  /** Translation key for the clear badge's accessible name. */
  clearLabelKey: string;
  /** Translation key for the refusal shown when execute finds it empty. */
  errorKey: string;
}

/** Every slot, by name. */
export const VIDEO_SLOTS = {
  firstFrame: {
    field: 'firstFrameUrl',
    param: 'image',
    purpose: 'firstFrame',
    accepts: 'image',
    Icon: Image,
    testId: 'generate-video-tool-first-frame',
    thumbnailTestId: 'generate-video-first-frame-thumbnail',
    clearTestId: 'generate-video-first-frame-clear',
    labelKey: 'canvas.generatePanel.firstFrame',
    tipKey: 'canvas.generatePanel.firstFrameTip',
    clearLabelKey: 'canvas.generatePanel.removeFirstFrame',
    errorKey: 'canvas.generatePanel.errorNoFirstFrame',
  },
  endFrame: {
    field: 'endFrameUrl',
    param: 'end_image',
    purpose: 'endFrame',
    accepts: 'image',
    Icon: Image,
    testId: 'generate-video-tool-end-frame',
    thumbnailTestId: 'generate-video-end-frame-thumbnail',
    clearTestId: 'generate-video-end-frame-clear',
    labelKey: 'canvas.generatePanel.endFrame',
    tipKey: 'canvas.generatePanel.endFrameTip',
    clearLabelKey: 'canvas.generatePanel.removeEndFrame',
    errorKey: 'canvas.generatePanel.errorNoEndFrame',
  },
  characterImage: {
    field: 'characterImageUrl',
    param: 'image',
    purpose: 'characterImage',
    accepts: 'image',
    Icon: UserRound,
    testId: 'generate-video-tool-character-image',
    thumbnailTestId: 'generate-video-character-image-thumbnail',
    clearTestId: 'generate-video-character-image-clear',
    labelKey: 'canvas.generatePanel.characterImage',
    tipKey: 'canvas.generatePanel.characterImageTip',
    clearLabelKey: 'canvas.generatePanel.removeCharacterImage',
    errorKey: 'canvas.generatePanel.errorNoCharacterImage',
  },
  drivingVideo: {
    field: 'drivingVideo',
    storesCover: true,
    param: 'video',
    purpose: 'drivingVideo',
    accepts: 'video',
    Icon: Video,
    testId: 'generate-video-tool-driving-video',
    thumbnailTestId: 'generate-video-driving-video-thumbnail',
    clearTestId: 'generate-video-driving-video-clear',
    labelKey: 'canvas.generatePanel.drivingVideo',
    tipKey: 'canvas.generatePanel.drivingVideoTip',
    clearLabelKey: 'canvas.generatePanel.removeDrivingVideo',
    errorKey: 'canvas.generatePanel.errorNoDrivingVideo',
  },
  drivingAudio: {
    field: 'drivingAudio',
    // `storesCover` because audio is not an image, which is the whole test
    // this flag applies — see the comment on it. An audio node happens to
    // carry no poster, so the stored value is `{url}` and the toolbar covers
    // the button with the AUDIO NODE's icon instead of a thumbnail (#1946).
    storesCover: true,
    param: 'audio',
    purpose: 'drivingAudio',
    accepts: 'audio',
    Icon: AudioLines,
    testId: 'generate-video-tool-driving-audio',
    thumbnailTestId: 'generate-video-driving-audio-thumbnail',
    clearTestId: 'generate-video-driving-audio-clear',
    labelKey: 'canvas.generatePanel.drivingAudio',
    tipKey: 'canvas.generatePanel.drivingAudioTip',
    clearLabelKey: 'canvas.generatePanel.removeDrivingAudio',
    errorKey: 'canvas.generatePanel.errorNoDrivingAudio',
  },
} as const satisfies Record<VideoSlot, VideoSlotSpec>;

/**
 * One URL per slot. Absent means this map has nothing for that slot — which
 * does NOT by itself mean the slot is empty: the panel builds two of these,
 * one for the picked assets and one for the pictures to show, and a filled
 * slot whose asset an `<img>` cannot paint is absent from the second.
 */
export type VideoSlotUrls = Partial<Record<VideoSlot, string>>;

/**
 * A stored value that is really a URL.
 *
 * An empty string is a string and no URL, and node data is a CRDT map any
 * client may write, so the type saying `string` proves nothing.
 * @param value - The raw stored value.
 * @returns The URL, or undefined when there is not one.
 */
function usableUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads a slot's stored pick, in the shape THAT slot keeps it in.
 *
 * This function IS the stored contract — a slot keeps a bare URL, or `{url,
 * cover}` when the picked asset is not its own picture. Stated here rather
 * than as a type alias nothing is checked against: the wire declaration
 * (`CanvasNodeFields.data`) and this reader are what a stored value actually
 * has to satisfy, and a third restatement would be one more thing to drift.
 *
 * A video's poster travels WITH it rather than in a field of its own, because
 * two fields are two independent last-writer-wins registers: two clients
 * picking different videos at once converge per-key, and the loser's poster
 * can survive under the winner's video (`canvas-space-slot-concurrency.test`).
 *
 * The shape is the slot's, not the value's: a slot storing a bare URL refuses
 * an object and a slot storing `{url, cover}` refuses a bare string. Slot
 * values are collaborative Yjs data — untrusted, whatever the type says — so
 * reading whichever shape happens to be there would let a malformed value
 * ride the payload as a source param and be refused upstream AFTER the task
 * was accepted and billed.
 *
 * An empty string is a string and no URL. A poster that is missing or
 * malformed leaves the slot covering itself with the asset node's icon rather
 * than an empty frame, which at least names what it holds (#1946).
 * @param spec - The slot being read, which states its stored shape.
 * @param value - The raw node-data value for that slot's field.
 * @returns The asset URL and what to show for it, or null when there is no pick.
 */
export function readSlotPick(
  spec: VideoSlotSpec,
  value: unknown,
): { url: string; thumbnail?: string } | null {
  if (!spec.storesCover) {
    const bare = usableUrl(value);
    return bare ? { url: bare, thumbnail: bare } : null;
  }
  if (value === null || typeof value !== 'object') return null;
  const url = usableUrl((value as { url?: unknown }).url);
  if (!url) return null;
  const cover = usableUrl((value as { cover?: unknown }).cover);
  return cover ? { url, thumbnail: cover } : { url };
}

/**
 * Finds the slot a pick is filling, if any.
 *
 * The canvas dispatches on the pick's purpose and needs to know which slot —
 * and what it accepts — before it can decide what a click on a node does.
 * @param purpose - The running pick's purpose.
 * @returns The slot that pick fills, or undefined when it fills none.
 */
export function slotForPurpose(purpose: PickPurpose): VideoSlot | undefined {
  return (Object.keys(VIDEO_SLOTS) as VideoSlot[]).find(
    (slot) => VIDEO_SLOTS[slot].purpose === purpose,
  );
}
