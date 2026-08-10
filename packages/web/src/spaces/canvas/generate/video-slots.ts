// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every source slot the video panel can offer, and everything one is made of.
 *
 * A slot is a pick-time COPY of one asset's URL, with a role: the first frame,
 * the end frame, and later a character image and a driving audio track. It is
 * not a reference — references are a relationship (an edge), a slot is a value.
 *
 * Each slot's facts live here rather than spread across the toolbar, the
 * canvas click handler, the candidate highlighting and the payload builder.
 * That spread is what let the first-frame slot ship telling the user to
 * "select a reference" (#1902): three of those sites were extended and the
 * fourth was not. A slot is one entry here plus the mode options that name it.
 */

import { Image } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { NodeType } from '@breatic/shared';

import type { PickPurpose } from '@web/stores/canvas';

/** The source slots the video panel knows how to offer. */
export type VideoSlot = 'firstFrame' | 'endFrame';

/** What one slot is made of. */
export interface VideoSlotSpec {
  /** Node data field holding the picked URL. */
  field: 'firstFrameUrl' | 'endFrameUrl';
  /** The param the URL travels as, under our own names. */
  param: string;
  /** The pick this slot starts; the canvas dispatches on it. */
  purpose: PickPurpose;
  /** The node type a click may fill this slot from. */
  accepts: NodeType;
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
  /** Translation key for its tooltip. */
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
} as const satisfies Record<VideoSlot, VideoSlotSpec>;

/** URLs picked into slots, by slot. Absent means the slot is empty. */
export type VideoSlotUrls = Partial<Record<VideoSlot, string>>;

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
