// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Image, Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  SlotTool,
  ToggleTool,
} from '@web/spaces/canvas/generate/generate-tools';

interface VideoGenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /** Whether the reference pick is running — highlights the button. */
  referenceActive?: boolean;
  /**
   * Whether the active mode takes a first frame. Read off the model's
   * per-mode source needs, so text-to-video shows no slot at all rather than
   * a slot the submit would ignore.
   */
  firstFrameSupported: boolean;
  /** Toggle the first-frame pick. */
  onFirstFrame: () => void;
  /** Whether the first-frame pick is running — highlights the slot. */
  firstFrameActive?: boolean;
  /** The picked first-frame URL (pick-time copy), or undefined when empty. */
  firstFrameUrl?: string;
  /** Clear the picked first frame (the slot's ✕ badge). */
  onClearFirstFrame: () => void;
}

/**
 * The video Generate panel's top tool row: Reference first, then the source
 * slots the active mode needs (design §4.2 — "leftmost is always Reference").
 *
 * Reference is present in every mode: a connected node feeds the prompt's `@`
 * mentions whatever the model generates from. The first-frame slot appears
 * only for the modes that take one — showing it under text-to-video would
 * offer a pick the submit then ignores.
 *
 * Its own row rather than a mode of the image toolbar: the image panel's tools
 * are Style and Focus, which mean nothing here, and video's grow with each
 * mode (end frame, character image, driving audio). What the two rows are
 * built FROM is shared — {@link ToggleTool} and {@link SlotTool}.
 * @param root0 - Component props.
 * @param root0.onReference - Enter / exit the reference pick.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @param root0.firstFrameSupported - Whether the active mode takes a first frame.
 * @param root0.onFirstFrame - Enter / exit the first-frame pick.
 * @param root0.firstFrameActive - Whether the first-frame pick is running.
 * @param root0.firstFrameUrl - The picked first-frame URL, if any.
 * @param root0.onClearFirstFrame - Clear the picked first frame.
 * @returns The tool row.
 */
export const VideoGenerateToolbar = React.memo(function VideoGenerateToolbar({
  onReference,
  referenceActive = false,
  firstFrameSupported,
  onFirstFrame,
  firstFrameActive = false,
  firstFrameUrl,
  onClearFirstFrame,
}: VideoGenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-1' role='group'>
      <ToggleTool
        testId='generate-video-tool-reference'
        label={t('canvas.generatePanel.reference')}
        tip={t('canvas.generatePanel.referenceTip')}
        Icon={Plus}
        onClick={onReference}
        active={referenceActive}
      />
      {firstFrameSupported ? (
        <SlotTool
          testId='generate-video-tool-first-frame'
          thumbnailTestId='generate-video-first-frame-thumbnail'
          clearTestId='generate-video-first-frame-clear'
          Icon={Image}
          onPick={onFirstFrame}
          active={firstFrameActive}
          thumbnail={firstFrameUrl}
          onClear={onClearFirstFrame}
          // Never gated once shown: the slot only renders for modes that take
          // a first frame, so there is no state where it is visible but
          // unpickable (Style needs that gate because it renders in both
          // image modes and only some models accept it).
          disabled={false}
          clearLabel={t('canvas.generatePanel.removeFirstFrame')}
          label={t('canvas.generatePanel.firstFrame')}
          tip={t('canvas.generatePanel.firstFrameTip')}
        />
      ) : null}
    </div>
  );
});
