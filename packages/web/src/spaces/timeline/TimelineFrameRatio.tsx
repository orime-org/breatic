// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { TIMELINE_FRAME_PRESETS, TIMELINE_FRAME_PRESET_KEYS, timelineFramePresetOf, type TimelineFramePreset } from '@breatic/shared';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';

/** The frame size and what choosing a preset does. */
interface TimelineFrameRatioProps {
  width: number;
  height: number;
  readOnly: boolean;
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
 * @param props.onChoose - Writes the chosen preset.
 * @returns The control.
 * @throws {never} Never.
 */
export const TimelineFrameRatio = React.memo(function TimelineFrameRatio({ width, height, readOnly, onChoose }: TimelineFrameRatioProps): React.JSX.Element {
  const current = timelineFramePresetOf({ width, height });
  const choose = React.useCallback((value: string): void => {
    const preset = TIMELINE_FRAME_PRESET_KEYS.find((key) => key === value);
    if (preset !== undefined) onChoose(preset);
  }, [onChoose]);
  return <Select value={current ?? ''} onValueChange={choose} disabled={readOnly}>
    <SelectTrigger data-testid='timeline-frame-ratio' className='h-[var(--btn-inline)] w-auto shrink-0 gap-2 text-xs tabular-nums data-[placeholder]:text-muted-foreground'><SelectValue placeholder={`${width}×${height}`} /></SelectTrigger>
    <SelectContent>{TIMELINE_FRAME_PRESET_KEYS.map((preset) => <SelectItem key={preset} value={preset}>{labelOf(preset)}</SelectItem>)}</SelectContent>
  </Select>;
});
