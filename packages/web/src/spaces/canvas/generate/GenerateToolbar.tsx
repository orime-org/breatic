// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { Focus, Plus } from 'lucide-react';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { IMAGE_SLOTS } from '@web/spaces/canvas/generate/image-slots';
import { SlotTool, ToggleTool, ToolRowDivider } from '@web/spaces/canvas/generate/generate-tools';

interface GenerateToolbarProps {
  /** Toggle the "select a reference from the canvas" mode (enter, or exit while active). */
  onReference: () => void;
  /**
   * Whether the reference pick is running — renders the button in its active
   * (highlighted) state so it reads as a toggle (user 2026-07-12 G).
   */
  referenceActive?: boolean;
  /** Toggle the focus crop mode (#1782, marquee → focusImages append). */
  onFocus: () => void;
  /** Whether the focus pick is running — highlights the Focus button. */
  focusActive?: boolean;
  /**
   * How many style images the model takes, or undefined when it takes none
   * and no style area is drawn (inner#826).
   */
  styleCap?: number;
  /** The node's style images, in pick order. */
  styleImages?: readonly string[];
  /** Enter / exit the style pick, which adds one image per click. */
  onStylePick?: () => void;
  /** Whether the style pick is running. */
  styleActive?: boolean;
  /** Take one style image out. */
  onRemoveStyle?: (url: string) => void;
}

const NO_IMAGES: readonly string[] = [];
/**
 * The handler a style control gets when its panel wires none.
 */
const NOTHING = (): void => {};

/**
 * The Generate panel's top tool row: Reference / Focus, both live canvas
 * picks, each with a hover tooltip describing what it does. Both are live in
 * BOTH modes and neither takes a disabled flag. Neither pick scopes by mode:
 * the reference one stopped in #1797, and the focus one never did — its
 * candidate rule asks only for a non-empty idle image node. So what a t2i node
 * cannot use is refused on the reference ROW, which dims and says why this
 * mode has no use for it (#1952 / #1986). Focus crops a region into a
 * standalone reference (#1782). When the model takes style images, a divider
 * follows and then the style area: one thumbnail per held image, each with its
 * own X, and while there is room an add control reading "Style" or n/cap
 * (inner#826).
 * @param root0 - Component props.
 * @param root0.onReference - Enter the reference-pick mode.
 * @param root0.referenceActive - Whether the reference pick is running.
 * @param root0.onFocus - Enter / exit the focus crop pick.
 * @param root0.focusActive - Whether the focus pick is running.
 * @param root0.styleCap - How many style images the model takes; undefined draws no style area.
 * @param root0.styleImages - The node's style images, in pick order.
 * @param root0.onStylePick - Enter / exit the style pick.
 * @param root0.styleActive - Whether the style pick is running.
 * @param root0.onRemoveStyle - Take one style image out.
 * @returns The tool row.
 */
export const GenerateToolbar = React.memo(function GenerateToolbar({
  onReference,
  referenceActive = false,
  onFocus,
  focusActive = false,
  styleCap,
  styleImages = NO_IMAGES,
  onStylePick = NOTHING,
  styleActive = false,
  onRemoveStyle,
}: GenerateToolbarProps): React.JSX.Element {
  const t = useTranslation();
  const spec = IMAGE_SLOTS.style;
  const shown = styleCap === undefined ? NO_IMAGES : styleImages.slice(0, styleCap);
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
      {styleCap !== undefined && <ToolRowDivider testId='generate-tool-sep' />}
      {shown.map((url, i) => (
        <SlotTool
          key={url}
          testId={`${spec.testId}-item-${i}`}
          thumbnailTestId={`${spec.thumbnailTestId}-${i}`}
          clearTestId={`${spec.clearTestId}-${i}`}
          Icon={spec.Icon}
          onPick={onStylePick}
          active={styleActive}
          pick={{ kind: 'image', url, thumbnail: url }}
          onClear={() => onRemoveStyle?.(url)}
          disabled={false}
          clearLabel={t(spec.clearLabelKey)}
          label={t(spec.labelKey)}
          tip={t(spec.tipKey)}
        />
      ))}
      {styleCap !== undefined && shown.length < styleCap && (
        <SlotTool
          testId={spec.testId}
          thumbnailTestId={spec.thumbnailTestId}
          clearTestId={spec.clearTestId}
          Icon={spec.Icon}
          onPick={onStylePick}
          active={styleActive}
          pick={undefined}
          onClear={NOTHING}
          disabled={false}
          clearLabel={t(spec.clearLabelKey)}
          label={shown.length === 0 ? t(spec.labelKey) : `${shown.length}/${styleCap}`}
          tip={t(spec.tipKey)}
        />
      )}
    </div>
  );
});
