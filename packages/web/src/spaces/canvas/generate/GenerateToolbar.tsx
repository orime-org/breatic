// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Focus, Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import {
  SlotTool,
  ToggleTool,
  ToolRowDivider,
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
   * Whether the active model takes a style image (`style_images`). Without it
   * the Style slot is not drawn; a copy picked under another model stays on the
   * node and is not sent.
   */
  styleSupported?: boolean;
  /** Toggle the focus crop mode (#1782, marquee → focusImages append). */
  onFocus: () => void;
  /** Whether the focus pick is running — highlights the Focus button. */
  focusActive?: boolean;
}

/**
 * The Generate panel's top tool row: Reference / Focus / Style — all three are
 * live canvas picks. The two toggles carry a hover tooltip describing what they
 * do; Style is a slot, and a slot's one hover surface is its preview, which
 * carries the same sentence as the card's hint while empty (#1946). (Mark
 * was dropped 2026-07-17, user decision C: its intent is already covered by
 * Focus). Reference and Focus are live in BOTH modes and neither takes a
 * disabled flag. Neither pick scopes by mode: the reference one stopped in
 * #1797, and the focus one never did — its candidate rule asks only for a
 * non-empty idle image node. So what a t2i node cannot use is refused on the
 * reference ROW, which dims and says why this mode has no use for it
 * (#1952 / #1986). Style is the one that can be left out here, and on a different
 * axis — the active MODEL's `style_images` capability, never the mode
 * (#1664). Focus crops a region into a standalone reference (#1782).
 * @param root0 - Component props.
 * @param root0.onReference - Enter the reference-pick mode.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @param root0.onStyle - Enter the style-pick mode.
 * @param root0.styleActive - Whether the style pick is running.
 * @param root0.styleThumbnail - The picked style image URL, if any.
 * @param root0.onClearStyle - Clear the picked style image.
 * @param root0.styleSupported - Whether the model takes a style image.
 * @param root0.onFocus - Enter / exit the focus crop pick.
 * @param root0.focusActive - Whether the focus pick is running.
 * @returns The tool row.
 */
export const GenerateToolbar = React.memo(function GenerateToolbar({
  onReference,
  referenceActive = false,
  onStyle,
  styleActive = false,
  styleThumbnail,
  onClearStyle,
  styleSupported = true,
  onFocus,
  focusActive = false,
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
      />
      {styleSupported && <ToolRowDivider testId='generate-tool-sep' />}
      {styleSupported && (
        <SlotTool
          testId={IMAGE_SLOTS.style.testId}
          thumbnailTestId={IMAGE_SLOTS.style.thumbnailTestId}
          clearTestId={IMAGE_SLOTS.style.clearTestId}
          Icon={IMAGE_SLOTS.style.Icon}
          onPick={onStyle}
          active={styleActive}
          // The style slot holds an image, so its pick IS its picture — asset
          // and thumbnail are the same URL, and it can never be full without one.
          pick={
            styleThumbnail === undefined
              ? undefined
              : { kind: 'image', url: styleThumbnail, thumbnail: styleThumbnail }
          }
          onClear={onClearStyle}
          disabled={false}
          clearLabel={t(IMAGE_SLOTS.style.clearLabelKey)}
          label={t(IMAGE_SLOTS.style.labelKey)}
          tip={t(IMAGE_SLOTS.style.tipKey)}
        />
      )}
    </div>
  );
});
