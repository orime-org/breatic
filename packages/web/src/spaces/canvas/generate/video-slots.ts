// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import type { SlotSpec } from '@web/spaces/canvas/generate/slots';

/**
 * What one slot is made of, under the name this registry's callers know.
 *
 * The structure moved to {@link ./slots} when the audio panel grew a slot of
 * its own (#1960): one definition, two registries.
 */
export type VideoSlotSpec = SlotSpec;

/** The source slots the video panel knows how to offer. */
export type VideoSlot =
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'drivingAudio';

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
