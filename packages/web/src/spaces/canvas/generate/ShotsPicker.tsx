// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { ShotsChoice } from '@breatic/shared';
import * as React from 'react';

import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { ChoiceMenu, type ChoiceMenuOption } from '@web/spaces/canvas/generate/ChoiceMenu';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';

interface ShotsPickerProps {
  /** The choice the node is on. */
  value: ShotsChoice;
  /** Whether the model can plan the shots itself (Kling), which adds Auto multi-shot. */
  auto: boolean;
  /** Called with a newly picked choice. */
  onSelect: (choice: ShotsChoice) => void;
}

/**
 * The video panel's Shots control (inner#2192), beside the params pill in the
 * settings row: one shot from the prompt, the shots written out one by one, or,
 * on a model that can, the shots planned by the model. Drawn by the panel only
 * where the model takes shots in the mode.
 * @param root0 - Props.
 * @param root0.value - The choice the node is on.
 * @param root0.auto - Whether Auto multi-shot is offered.
 * @param root0.onSelect - Called with a newly picked choice.
 * @returns The pill.
 */
export const ShotsPicker = React.memo(function ShotsPicker({ value, auto, onSelect }: ShotsPickerProps): React.JSX.Element {
  const t = useTranslation();
  const [open, setOpen] = React.useState(false);
  // Radix does not follow the canvas's CSS-transform pan and zoom.
  useFollowCanvasViewport(open);
  const single = t('canvas.generatePanel.storyboard.single');
  const multi = t('canvas.generatePanel.storyboard.multi');
  const multiHint = t('canvas.generatePanel.storyboard.multiHint');
  const autoName = t('canvas.generatePanel.storyboard.auto');
  const autoHint = t('canvas.generatePanel.storyboard.autoHint');
  const options = React.useMemo((): ChoiceMenuOption[] => [
    { value: 'single', label: single, testId: 'generate-video-shots-single' },
    { value: 'multi', label: multi, hint: multiHint, testId: 'generate-video-shots-multi' },
    ...(auto ? [{ value: 'auto', label: autoName, hint: autoHint, testId: 'generate-video-shots-auto' }] : []),
  ], [single, multi, multiHint, auto, autoName, autoHint]);
  const select = React.useCallback((next: string | number): void => onSelect(next as ShotsChoice), [onSelect]);
  return (
    <ChoiceMenu value={value} options={options} onSelect={select} triggerTestId='generate-video-shots-trigger'
      triggerClassName={cn('shrink-0 rounded-full', value !== 'single' && 'border-active-border')}
      // Clipped at a screen edge rather than flipped, as the other pickers on the canvas are.
      side='top' avoidCollisions={false} onOpenChange={setOpen} />
  );
});
