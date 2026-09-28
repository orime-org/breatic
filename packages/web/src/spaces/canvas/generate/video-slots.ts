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

import { REFERENCE_POOL_PARAM, missingSources } from '@breatic/shared';
import type { MissingSource, ModelEntry } from '@breatic/shared';
import { AudioLines, Image, UserRound, Video } from 'lucide-react';

import type { SlotSpec } from '@web/spaces/canvas/generate/slots';
import { filledFromCanvas } from '@web/spaces/canvas/generate/canvas-filled';
import { slotsForMode } from '@web/spaces/canvas/generate/video-mode-options';

/** The source slots the video panel knows how to offer. */
export type VideoSlot =
  | 'firstFrame'
  | 'endFrame'
  | 'characterImage'
  | 'drivingVideo'
  | 'drivingAudio'
  | 'referenceVideo'
  | 'sourceVideo'
  | 'leftAudio'
  | 'rightAudio';

/**
 * A video slot.
 *
 * The execute gate refuses on the first empty REQUIRED slot and words the
 * refusal from that slot's own `errorKey`, so a required slot without one
 * would refuse with a blank message. Which slots are required is the model's
 * to say (#269) and is read per run in {@link videoMissing}, so any slot
 * here may turn out to be the one refused on: the key is required of every
 * entry rather than of a shape the registry could predict.
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
    // gate reads it there — so it carries an `errorKey` like every other
    // slot, for the model that does demand it.
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
  // The talking-head sources beyond a portrait and one track (#2156). The
  // lipsync models take a clip instead of a portrait and redo its lips; the
  // two-speaker model takes one track per side of the frame.
  sourceVideo: {
    field: 'sourceVideo',
    storesCover: true,
    param: 'video',
    purpose: 'sourceVideo',
    accepts: 'video',
    Icon: Video,
    testId: 'generate-video-tool-source-video',
    thumbnailTestId: 'generate-video-source-video-thumbnail',
    clearTestId: 'generate-video-source-video-clear',
    labelKey: 'canvas.generatePanel.sourceVideo',
    tipKey: 'canvas.generatePanel.sourceVideoTip',
    clearLabelKey: 'canvas.generatePanel.removeSourceVideo',
    errorKey: 'canvas.generatePanel.errorNoSourceVideo',
  },
  leftAudio: {
    field: 'leftAudio',
    storesCover: true,
    param: 'left_audio',
    purpose: 'leftAudio',
    accepts: 'audio',
    Icon: AudioLines,
    testId: 'generate-video-tool-left-audio',
    thumbnailTestId: 'generate-video-left-audio-thumbnail',
    clearTestId: 'generate-video-left-audio-clear',
    labelKey: 'canvas.generatePanel.leftAudio',
    tipKey: 'canvas.generatePanel.leftAudioTip',
    clearLabelKey: 'canvas.generatePanel.removeLeftAudio',
    errorKey: 'canvas.generatePanel.errorNoLeftAudio',
  },
  rightAudio: {
    field: 'rightAudio',
    storesCover: true,
    param: 'right_audio',
    purpose: 'rightAudio',
    accepts: 'audio',
    Icon: AudioLines,
    testId: 'generate-video-tool-right-audio',
    thumbnailTestId: 'generate-video-right-audio-thumbnail',
    clearTestId: 'generate-video-right-audio-clear',
    labelKey: 'canvas.generatePanel.rightAudio',
    tipKey: 'canvas.generatePanel.rightAudioTip',
    clearLabelKey: 'canvas.generatePanel.removeRightAudio',
    errorKey: 'canvas.generatePanel.errorNoRightAudio',
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
 * What a video run still needs, in the order the toolbar offers it.
 *
 * A slot and the reference pool are two gestures for one thing, and both are
 * places the run's material comes from. Which of them this mode needs is the
 * model's to say, through `missingSources` — the rule the server re-checks
 * before enqueue. The panel only reorders the answer, so the reader is told
 * about the first empty place on the toolbar rather than the first one the
 * model happened to declare.
 * @param model - The model the run names.
 * @param mode - The mode it is set to.
 * @param slots - The slots this panel draws for that mode, in display order.
 * @param slotUrls - What those slots hold.
 * @param references - The references the prompt names.
 * @returns Each unmet requirement, in toolbar order; empty when the run has
 *   what it needs or no model resolves.
 */
export function videoMissing(
  model: ModelEntry | undefined,
  mode: string,
  slots: readonly VideoSlot[],
  slotUrls: VideoSlotUrls,
  references: readonly string[],
): MissingSource[] {
  if (model === undefined) return [];
  const params: Record<string, unknown> = { [REFERENCE_POOL_PARAM]: references };
  for (const slot of slots) params[VIDEO_SLOTS[slot].param] = slotUrls[slot];
  const order = [...slots.map((slot) => VIDEO_SLOTS[slot].param), REFERENCE_POOL_PARAM];
  /**
   * Where a requirement's first param sits on the toolbar.
   * @param need - One unmet requirement.
   * @returns Its position; past the end for a param the toolbar does not draw.
   */
  const rank = (need: MissingSource): number => {
    const at = order.indexOf(need[0] ?? '');
    return at === -1 ? order.length : at;
  };
  return [...missingSources(model, mode, params)].sort((a, b) => rank(a) - rank(b));
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

/**
 * The slots the toolbar draws for this model in this mode, in display order.
 *
 * The mode's row says which slots it can collect; the model says which of
 * them it takes (#2156, design §6). One mode serves models collecting
 * different sets — a talking head is driven by a portrait, a clip, or two
 * speakers' tracks — so a slot the model does not declare is not drawn.
 * @param model - The model the run names, or undefined before one resolves.
 * @param mode - The mode it is set to.
 * @returns The drawn slots; the mode's whole row while no model resolves.
 */
export function videoSlotsForModel(
  model: ModelEntry | undefined,
  mode: string,
): readonly VideoSlot[] {
  const row = slotsForMode(mode);
  if (model === undefined) return row;
  return row.filter(
    (slot) => filledFromCanvas(model.params[VIDEO_SLOTS[slot].param], mode) !== undefined,
  );
}
