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
 * nowhere. `satisfies Record<PickPurpose, …>` turns the next omission into a
 * compile error instead of a wrong sentence on screen.
 */

import type { PickPurpose } from '@web/stores/canvas';

/** The panel kinds that own pick tools (the other panel kinds start none). */
type PickingPanelKind = 'generate' | 'generateVideo';

interface PickPurposeUi {
  /** Translation key for the pick banner's instruction. */
  banner: string;
  /**
   * Test id of the tool that starts this pick, per panel. Focus returns there
   * when the banner unmounts. Partial on purpose: most purposes belong to one
   * panel — style and focus are the image panel's, the first frame is the
   * video panel's, and only reference exists in both.
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
    trigger: { generate: 'generate-tool-focus' },
  },
  firstFrame: {
    banner: 'canvas.generatePanel.selectFirstFrameFromCanvas',
    trigger: { generateVideo: 'generate-video-tool-first-frame' },
  },
} as const satisfies Record<PickPurpose, PickPurposeUi>;
