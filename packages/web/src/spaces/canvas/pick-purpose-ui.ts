// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the canvas has to say — and where keyboard focus goes back to — for
 * each kind of pick.
 *
 * One table rather than a ternary at each site, because those sites drift:
 * adding the first-frame pick (#1902) extended the candidate-dimming rule and
 * the click handler but silently missed the banner and the focus hand-off, so
 * a first-frame pick told the user to "select a reference" and exited into
 * nowhere. The end frame (#1904) was the first slot to arrive after that.
 * `satisfies Record<PickPurpose, …>` turns the next omission into a compile
 * error instead of a wrong sentence on screen.
 *
 * A slot pick's trigger id is READ from the slot registry rather than written
 * again here. The toolbar renders that same entry, so the id this table
 * searches for and the id on screen are one string: written twice they agreed
 * by luck, and a typo in either was invisible — every canvas suite stayed
 * green while Exit dropped a keyboard user on the canvas container, which is
 * the miss above happening a second time.
 */

import { VIDEO_SLOTS } from '@web/spaces/canvas/generate/video-slots';
import type { PickPurpose } from '@web/stores/canvas';

/** The panel kinds that own pick tools (the other panel kinds start none). */
type PickingPanelKind = 'generate' | 'generateVideo';

interface PickPurposeUi {
  /** Translation key for the pick banner's instruction. */
  banner: string;
  /**
   * Test id of the tool that starts this pick, per panel. Focus returns there
   * when the banner unmounts. Partial on purpose: most purposes belong to one
   * panel — style is the image panel's, the frame and character slots are the
   * video panel's. Reference and focus are the two both panels offer.
   */
  trigger: Partial<Record<PickingPanelKind, string>>;
}

/** Banner copy + focus target for every pick purpose. */
export const PICK_PURPOSE_UI = {
  reference: {
    banner: 'canvas.generatePanel.selectFromCanvas',
    trigger: {
      generate: 'generate-tool-reference',
      generateVideo: 'generate-video-tool-reference',
    },
  },
  style: {
    banner: 'canvas.generatePanel.selectStyleFromCanvas',
    trigger: { generate: 'generate-tool-style' },
  },
  focus: {
    banner: 'canvas.generatePanel.selectFocusFromCanvas',
    trigger: {
      generate: 'generate-tool-focus',
      generateVideo: 'generate-video-tool-focus',
    },
  },
  firstFrame: {
    banner: 'canvas.generatePanel.selectFirstFrameFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.firstFrame.testId },
  },
  endFrame: {
    banner: 'canvas.generatePanel.selectEndFrameFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.endFrame.testId },
  },
  characterImage: {
    banner: 'canvas.generatePanel.selectCharacterImageFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.characterImage.testId },
  },
  drivingVideo: {
    banner: 'canvas.generatePanel.selectDrivingVideoFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.drivingVideo.testId },
  },
  drivingAudio: {
    banner: 'canvas.generatePanel.selectDrivingAudioFromCanvas',
    trigger: { generateVideo: VIDEO_SLOTS.drivingAudio.testId },
  },
} as const satisfies Record<PickPurpose, PickPurposeUi>;
