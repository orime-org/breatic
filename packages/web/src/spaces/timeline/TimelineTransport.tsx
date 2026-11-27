// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The Timeline play bar (inner#1709): the seek bar in a row of its own under the preview, then Play, the time and the
 * frame ratio. When the control row is too narrow it narrows in steps: the ratio without its size, then Play as an icon,
 * then the time without the total; the steps come back in reverse order as it widens.
 */

import * as React from 'react';
import type { TimelineFramePreset, TimelineRate } from '@breatic/shared';
import { Pause, Play } from 'lucide-react';

import { Button } from '@web/components/ui/button';
import { Slider } from '@web/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { TimelineFrameRatio } from '@web/spaces/timeline/TimelineFrameRatio';
import { formatTimelineTimecode } from '@web/spaces/timeline/timeline-timecode';
import { nextTransportForm } from '@web/spaces/timeline/transport-fit';

/** Each form's width, measured while it was shown, for one set of contents. */
interface FormWidths {
  content: string;
  byForm: (number | undefined)[];
}

/** The play bar. */
interface TimelineTransportProps {
  /** The playback state, mirrored on the bar for tests and styling. */
  state: string;
  playing: boolean;
  waiting: boolean;
  frame: number;
  duration: number;
  fps: TimelineRate;
  seekValue: number[];
  onSeek: (value: number[]) => void;
  onToggle: () => void;
  width: number;
  height: number;
  readOnly: boolean;
  onChoose: (preset: TimelineFramePreset) => void;
}

/**
 * The play bar with its seek row and its narrowing control row (inner#1709).
 * @param props - The play bar.
 * @param props.state - The playback state.
 * @param props.playing - Whether Play now pauses.
 * @param props.waiting - Whether the preview is buffering.
 * @param props.frame - The playhead frame.
 * @param props.duration - The Timeline's length in frames.
 * @param props.fps - Frames per second.
 * @param props.seekValue - The seek bar's value.
 * @param props.onSeek - Moves the playhead.
 * @param props.onToggle - Plays or pauses.
 * @param props.width - Frame width.
 * @param props.height - Frame height.
 * @param props.readOnly - Whether the user cannot edit.
 * @param props.onChoose - Writes the chosen frame preset.
 * @returns The play bar.
 * @throws {never} Never.
 */
export const TimelineTransport = React.memo(function TimelineTransport({ state, playing, waiting, frame, duration, fps, seekValue, onSeek, onToggle, width, height, readOnly, onChoose }: TimelineTransportProps): React.JSX.Element {
  const t = useTranslation();
  const row = React.useRef<HTMLDivElement>(null);
  const [room, setRoom] = React.useState<number | null>(null);
  const [form, setForm] = React.useState(0);
  // Each form's width, measured while it is shown; anything that changes a width starts the record over.
  const label = playing ? t('timeline.pause') : t('timeline.play');
  const total = formatTimelineTimecode(duration, fps);
  const content = `${label}|${total}|${width}×${height}`;
  const widths = React.useRef<FormWidths>({ content, byForm: [] });

  React.useLayoutEffect(() => {
    const element = row.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => { if (entry !== undefined) setRoom(entry.contentRect.width); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const element = row.current;
    if (element === null || room === null) return;
    if (widths.current.content !== content) widths.current = { content, byForm: [] };
    const style = getComputedStyle(element);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const parts = [...element.querySelectorAll<HTMLElement>('[data-transport-part]')];
    const spacer = element.querySelector<HTMLElement>('[data-transport-spacer]');
    const least = spacer === null ? 0 : Number.parseFloat(getComputedStyle(spacer).minWidth) || 0;
    widths.current.byForm[form] = parts.reduce((sum, part) => sum + part.getBoundingClientRect().width, 0) + gap * (element.children.length - 1) + least;
    setForm(nextTransportForm(form, widths.current.byForm, room));
  }, [room, form, content]);

  const icon = playing ? <Pause className='size-4' /> : <Play className='size-4' />;
  const iconOnly = form >= 2;
  const time = formatTimelineTimecode(frame, fps);
  return <div data-playback-state={state} className='flex shrink-0 flex-col border-t border-border'>
    <div className='px-4 pt-2'>
      <Slider aria-label={t('timeline.seek')} value={seekValue} onValueChange={onSeek} min={0} max={Math.max(1, duration - 1)} step={1} disabled={duration === 0} className='w-full' />
    </div>
    <div ref={row} data-testid='timeline-transport' data-transport-form={form} className='flex items-center gap-3 px-4 pb-2 pt-1'>
      {/* The tooltip sits on a wrapper so a disabled Play still names itself on hover. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-transport-part='play' className='inline-flex shrink-0'>
            <Button data-testid='timeline-play' variant='outline' size='sm' aria-label={iconOnly ? label : undefined} className={iconOnly ? 'w-[var(--btn-inline)] px-0' : 'gap-1.5'}
              disabled={duration === 0} onClick={onToggle} icon={icon}>{iconOnly ? null : label}</Button>
          </span>
        </TooltipTrigger>
        {iconOnly && <TooltipContent>{label}</TooltipContent>}
      </Tooltip>
      {/* The buffering text sits above the timecode, out of the flow, so nothing in the row moves when it appears. */}
      <div data-testid='timeline-timecode' data-transport-part='time' className='relative flex shrink-0'>
        <span className='whitespace-nowrap text-xs tabular-nums'>{form === 3 ? time : `${time} / ${total}`}</span>
        {waiting && <span className='pointer-events-none absolute bottom-full left-0 mb-0.5 whitespace-nowrap text-2xs leading-none text-muted-foreground'>{t('timeline.transport.waiting')}</span>}
      </div>
      <div data-transport-spacer='' className='min-w-3 flex-1' />
      <span data-transport-part='ratio' className='inline-flex shrink-0'>
        <TimelineFrameRatio width={width} height={height} readOnly={readOnly} compact={form >= 1} onChoose={onChoose} />
      </span>
    </div>
  </div>;
});
