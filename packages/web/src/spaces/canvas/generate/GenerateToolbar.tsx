// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Box, Focus, Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import {
  SlotTool,
  ToggleTool,
} from '@web/spaces/canvas/generate/generate-tools';

interface GenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /**
   * Whether the reference pick is running — renders the button in its active
   * (highlighted) state so it reads as a toggle (user 2026-07-12 G).
   */
  referenceActive?: boolean;
  /** Toggle the "select a style reference from the canvas" mode (#1664). */
  onStyle: () => void;
  /** Whether the style pick is running — highlights the Style button. */
  styleActive?: boolean;
  /** The picked style image URL (pick-time copy) shown in the Style slot. */
  styleThumbnail?: string;
  /** Clear the picked style image (the Style slot's ✕ badge). */
  onClearStyle: () => void;
  /**
   * Disable style PICKING — the active model declares no `style_images`
   * capability. A stale thumbnail still renders and its ✕ stays active.
   */
  styleDisabled?: boolean;
  /** Toggle the focus crop mode (#1782, marquee → focusImages append). */
  onFocus: () => void;
  /** Whether the focus pick is running — highlights the Focus button. */
  focusActive?: boolean;
  /** Disable Focus — like Reference it feeds i2i source images (t2i off). */
  focusDisabled?: boolean;
}

/**
 * The Generate panel's top tool row: Reference / Focus / Style — all three are
 * live canvas picks, each with a hover tooltip describing what it does (Mark
 * was dropped 2026-07-17, user decision C: its intent is already covered by
 * Focus). Reference is available in both modes — text-to-image scopes the pick
 * to text sources (the canvas pick rejects image nodes), image-to-image uses
 * the full pool; Style holds ONE picked style image as a pick-time copy (#1664)
 * — gated on the active MODEL's capability (`style_images` on the wire), never
 * on the mode; Focus crops a region into a standalone reference (#1782).
 * @param root0 - Component props.
 * @param root0.onReference - Enter the reference-pick mode.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @param root0.onStyle - Enter the style-pick mode.
 * @param root0.styleActive - Whether the style pick is running.
 * @param root0.styleThumbnail - The picked style image URL, if any.
 * @param root0.onClearStyle - Clear the picked style image.
 * @param root0.styleDisabled - Disable style picking (model capability gate).
 * @returns The tool row.
 */
export const GenerateToolbar = React.memo(function GenerateToolbar({
  onReference,
  referenceActive = false,
  onStyle,
  styleActive = false,
  styleThumbnail,
  onClearStyle,
  styleDisabled = false,
  onFocus,
  focusActive = false,
  focusDisabled = false,
}: GenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  return (
    <div className='flex items-center gap-1' role='group'>
      <ToggleTool
        testId='generate-tool-reference'
        label={t('canvas.generatePanel.reference')}
        tip={t('canvas.generatePanel.referenceTip')}
        Icon={Plus}
        onClick={onReference}
        active={referenceActive}
      />
      <ToggleTool
        testId='generate-tool-focus'
        label={t('canvas.generatePanel.focus')}
        tip={t('canvas.generatePanel.focusTip')}
        Icon={Focus}
        onClick={onFocus}
        active={focusActive}
        disabled={focusDisabled}
      />
      <SlotTool
        testId='generate-tool-style'
        thumbnailTestId='generate-style-thumbnail'
        clearTestId='generate-style-clear'
        Icon={Box}
        onPick={onStyle}
        active={styleActive}
        thumbnail={styleThumbnail}
        onClear={onClearStyle}
        disabled={styleDisabled}
        clearLabel={t('canvas.generatePanel.removeStyle')}
        label={t('canvas.generatePanel.style')}
        tip={t('canvas.generatePanel.styleTip')}
      />
    </div>
  );
});
