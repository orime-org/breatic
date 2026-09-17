// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every source slot the video panel can offer, and everything one is made of.
 *
 * A slot is a pick-time COPY of one asset, with a role: the first frame, the
 * end frame, the character image (which animation drives and the talking head
 * speaks), the driving video motion is taken from, the driving audio lips
 * follow, and the motion clip reference-to-video guides its motion by. It is
 * not a reference — references are a relationship (an edge), a slot is a
 * value.
 *
 * Each slot's facts live here rather than spread across the toolbar, the
 * canvas click handler, the candidate highlighting and the payload builder.
 * That spread is what let the first-frame slot ship telling the user to
 * "select a reference" (#1902): three of those sites were extended and the
 * fourth was not. A slot is one entry here plus the mode options that name it.
 */

import { REFERENCE_POOL_PARAM } from '@breatic/shared';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import { AudioLines, Image, UserRound, Video } from 'lucide-react';

import type { SlotSpec } from '@web/spaces/canvas/generate/slots';

/** The source slots the video panel knows how to offer. */
export type VideoSlot =
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'drivingAudio'
  | 'referenceVideo';

/**
 * A video slot, in one of its two shapes.
 *
 * The execute gate refuses on the first empty REQUIRED slot and words the
 * refusal from that slot's own `errorKey`, so a required slot without one
 * would refuse with a blank message. An optional slot is never refused on and
 * carries no such key. The two shapes are stated so that a required slot
 * missing its `errorKey` fails to compile.
 */
type VideoSlotSpec = SlotSpec & { errorKey: string };

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
    // carry no poster, so the stored value is `{url}` and the button paints no
    // thumbnail: it keeps its own icon and label and lights its border
    // (#1946, user 2026-09-06).
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
  referenceVideo: {
    field: 'referenceVideo',
    // Whether a run can go without this one is the model's to say, and the
    // gate reads it there. A slot no model ever demands needs no `errorKey`.
    storesCover: true,
    param: 'video',
    purpose: 'referenceVideo',
    accepts: 'video',
    Icon: Video,
    testId: 'generate-video-tool-reference-video',
    thumbnailTestId: 'generate-video-reference-video-thumbnail',
    clearTestId: 'generate-video-reference-video-clear',
    labelKey: 'canvas.generatePanel.referenceVideo',
    tipKey: 'canvas.generatePanel.referenceVideoTip',
    clearLabelKey: 'canvas.generatePanel.removeReferenceVideo',
    errorKey: 'canvas.generatePanel.errorNoReferenceVideo',
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
 * Whether this mode fills a param off the canvas, and whether it may stay empty.
 * @param spec - What the model declares about the param.
 * @param mode - The mode being asked about.
 * @returns How the param is filled here, or undefined when nothing fills it.
 */
function filledFromCanvas(
  spec: ParamDescriptor | undefined,
  mode: string,
): { fill: 'canvas' | 'pool'; optional: boolean } | undefined {
  if (spec?.fill !== 'canvas' && spec?.fill !== 'pool') return undefined;
  // `modes` narrows a param to some of the model's modes; absent means all.
  if (spec.modes !== undefined && !spec.modes.includes(mode)) return undefined;
  return { fill: spec.fill, optional: spec.optional === true };
}

/**
 * Where a video run takes material, in the order the toolbar offers it.
 *
 * A slot and the reference pool are two gestures for one thing, and both are
 * places the run's material comes from. Which of them this mode has, and which
 * it may leave empty, is the model's to say: one vendor's reference-to-video
 * generates without the motion clip and another may not, and the panel cannot
 * tell them apart from its own registry.
 * @param model - The model the run names.
 * @param mode - The mode it is set to.
 * @param slots - The slots this panel draws for that mode, in display order.
 * @param slotUrls - What those slots hold.
 * @param references - The references the prompt names.
 * @returns The places, and which of them hold something.
 */
export function videoSourcePlaces(
  model: ModelEntry | undefined,
  mode: string,
  slots: readonly VideoSlot[],
  slotUrls: VideoSlotUrls,
  references: readonly string[],
): { requiredSlots: string[]; filledSlots: string[] } {
  const params = model?.params ?? {};
  const requiredSlots: string[] = [];
  for (const slot of slots) {
    const declared = filledFromCanvas(params[VIDEO_SLOTS[slot].param], mode);
    if (declared && !declared.optional) requiredSlots.push(slot);
  }
  if (filledFromCanvas(params[REFERENCE_POOL_PARAM], mode)?.fill === 'pool') {
    requiredSlots.push(REFERENCE_POOL_PARAM);
  }
  const filledSlots = requiredSlots.filter((place) =>
    place === REFERENCE_POOL_PARAM
      ? references.length > 0
      : slotUrls[place as VideoSlot] !== undefined,
  );
  return { requiredSlots, filledSlots };
}

/**
 * Whether this mode draws on the reference pool at all.
 *
 * The rail dims its rows and the payload carries the picked URLs only for a
 * mode that does, and the model declares it by giving the pool param a `pool`
 * fill in that mode.
 * @param model - The model the run names.
 * @param mode - The mode it is set to.
 * @returns True when the pool feeds this run.
 */
export function modelTakesReferences(model: ModelEntry | undefined, mode: string): boolean {
  return filledFromCanvas(model?.params?.[REFERENCE_POOL_PARAM], mode)?.fill === 'pool';
}
