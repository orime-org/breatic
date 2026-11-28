// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { TIMELINE_FRAME_PRESETS, TIMELINE_FRAME_PRESET_KEYS, timelineFramePresetOf, type TimelineFramePreset } from '@breatic/shared';

import { Ratio } from 'lucide-react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';

/** How the frame ratio control shows the current frame. */
export type TimelineFrameRatioForm = 'full' | 'ratio' | 'icon';

/** The frame size and what choosing a preset does. */
interface TimelineFrameRatioProps {
  width: number;
  height: number;
  readOnly: boolean;
  /**
   * How the control shows the frame, for a narrow play bar (inner#1709): ratio and size, the ratio alone, or a ratio icon
   * named on hover. The list always shows ratio and size.
   */
  form?: TimelineFrameRatioForm;
  /** Writes the chosen preset. */
  onChoose: (preset: TimelineFramePreset) => void;
}

/**
 * A preset as the control lists it: its ratio, then its size muted in tabular digits so the sizes line up.
 * @param preset - The preset.
 * @returns The label, whose text is such as "9:16 · 1080×1920".
 * @throws {never} Never.
 */
function labelOf(preset: TimelineFramePreset): React.JSX.Element {
  const { width, height } = TIMELINE_FRAME_PRESETS[preset];
  // The space between the parts is its own text node: an accessible name trims each element's text, so a space inside a
  // span would be lost and the option would no longer be named "9:16 · 1080×1920".
  return <><span className='inline-block min-w-[4ch]'>{preset}</span>{' '}<span className='text-muted-foreground tabular-nums'>{`· ${width}×${height}`}</span></>;
}

/**
 * The Timeline frame ratio control at the right end of the play bar (#1502): it shows the current preset, or the stored
 * size muted with no preset checked for a size outside the presets, and is disabled for a Viewer.
 * @param props - The frame size and the commit.
 * @param props.width - Frame width.
 * @param props.height - Frame height.
 * @param props.readOnly - Whether the user cannot edit.
 * @param props.form - How the control shows the frame.
 * @param props.onChoose - Writes the chosen preset.
 * @returns The control.
 * @throws {never} Never.
 */
export const TimelineFrameRatio = React.memo(function TimelineFrameRatio({ width, height, readOnly, form = 'full', onChoose }: TimelineFrameRatioProps): React.JSX.Element {
  const current = timelineFramePresetOf({ width, height });
  const choose = React.useCallback((value: string): void => {
    const preset = TIMELINE_FRAME_PRESET_KEYS.find((key) => key === value);
    if (preset !== undefined) onChoose(preset);
  }, [onChoose]);
  const t = useTranslation();
  const name = `${t('timeline.frameRatio')} · ${current ?? `${width}×${height}`}`;
  // The control always draws its own value: left to Radix, the selected row's text is copied in only after an effect, so
  // switching to the ratio alone would briefly show both and the play bar would measure it too wide (inner#1709).
  const shown = current === undefined ? undefined : form === 'ratio' ? <span className='inline-block min-w-[4ch]'>{current}</span> : labelOf(current);
  // The icon form hides the trigger's own chevron (its last child), so the control is a square like the icon-only Play.
  const trigger = form === 'icon'
    ? <SelectTrigger data-testid='timeline-frame-ratio' aria-label={name} className='h-[var(--btn-inline)] w-[var(--btn-inline)] shrink-0 justify-center px-0 [&>svg:last-child]:hidden'><Ratio className='size-4' /></SelectTrigger>
    : <SelectTrigger data-testid='timeline-frame-ratio' className='h-[var(--btn-inline)] w-auto shrink-0 gap-2 text-xs tabular-nums data-[placeholder]:text-muted-foreground'><SelectValue placeholder={`${width}×${height}`}>{shown}</SelectValue></SelectTrigger>;
  return <Select value={current ?? ''} onValueChange={choose} disabled={readOnly}>
    {/* The tooltip sits on a wrapper so a disabled control still names itself on hover. */}
    {form === 'icon' ? <Tooltip><TooltipTrigger asChild><span className='inline-flex shrink-0'>{trigger}</span></TooltipTrigger><TooltipContent>{name}</TooltipContent></Tooltip> : trigger}
    <SelectContent>{TIMELINE_FRAME_PRESET_KEYS.map((preset) => <SelectItem key={preset} value={preset}>{labelOf(preset)}</SelectItem>)}</SelectContent>
  </Select>;
});
