// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { newId, TIMELINE_MAIN_TRACK_ID, timelineSourceOverflow, type TimelineDocumentV1, type TimelineEditCommand, type TimelineEditPlacement, type TimelineVideoClip } from '@breatic/shared';

import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { useTranslation } from '@web/i18n/use-translation';
import type { TimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';

/** The selected clip's editable properties. */
interface TimelineClipPropertiesProps {
  spaceId: string;
  document: TimelineDocumentV1;
  clip: TimelineVideoClip;
  name: string;
  conflict: boolean;
  labels: TimelineTrackLabels;
  readOnly: boolean;
  placement: TimelineEditPlacement;
  onCommit: (command: TimelineEditCommand) => void;
}

type Field = 'start' | 'in' | 'duration';

/**
 * The clip's draft values as text, refreshed when the stored clip changes.
 * @param clip - The stored clip.
 * @returns Draft text per field.
 * @throws {never} Never.
 */
function draftOf(clip: TimelineVideoClip): Record<Field, string> {
  return { start: String(clip.startFrame), in: String(clip.sourceInFrame), duration: String(clip.durationFrames) };
}

/**
 * Track, start, in-point and duration of the selected clip; edits commit on Enter or blur.
 * @param props - The clip, its context and the commit callback.
 * @param props.spaceId - The Space, for field ids.
 * @param props.document - The current Timeline, for the clip's source extent.
 * @param props.clip - The selected clip.
 * @param props.name - Its display name.
 * @param props.conflict - Whether the arrangement reports a conflict.
 * @param props.labels - Track names.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.placement - The editing user's switches.
 * @param props.onCommit - Commits an edit.
 * @returns The properties fields.
 * @throws {never} Never.
 */
export function TimelineClipProperties({ spaceId, document, clip, name, conflict, labels, readOnly, placement, onCommit }: TimelineClipPropertiesProps): React.JSX.Element {
  const t = useTranslation();
  const [draft, setDraft] = React.useState(() => ({ key: `${clip.id}:${clip.startFrame}:${clip.sourceInFrame}:${clip.durationFrames}`, values: draftOf(clip), error: null as Field | null }));
  const key = `${clip.id}:${clip.startFrame}:${clip.sourceInFrame}:${clip.durationFrames}`;
  const current = draft.key === key ? draft : { key, values: draftOf(clip), error: null };
  if (current !== draft) setDraft(current);
  const source = document.sources[clip.sourceId];
  const fps = document.settings.fps;
  const startLocked = placement.magnet && clip.trackId === TIMELINE_MAIN_TRACK_ID;
  const trackName = labels.nameOf(clip.trackId);

  const change = React.useCallback((field: Field, value: string): void => {
    setDraft((previous) => ({ ...previous, values: { ...previous.values, [field]: value }, error: null }));
  }, []);
  const commit = React.useCallback((field: Field): void => {
    const values = current.values;
    const start = Number(values.start);
    const sourceIn = Number(values.in);
    const duration = Number(values.duration);
    const valid = field === 'start'
      ? Number.isSafeInteger(start) && start >= 0
      : [sourceIn, duration].every(Number.isSafeInteger) && sourceIn >= 0 && duration >= 1 && source !== undefined
        && timelineSourceOverflow({ ...clip, sourceInFrame: sourceIn, durationFrames: duration }, source, fps) === 0;
    if (!valid) { setDraft((previous) => ({ ...previous, error: field })); return; }
    if (field === 'start') {
      if (start !== clip.startFrame) onCommit({ operation: 'move', parameters: { clipId: clip.id, startFrame: start }, placement });
    } else if (sourceIn !== clip.sourceInFrame || duration !== clip.durationFrames) {
      onCommit({ operation: 'set_range', parameters: { clipId: clip.id, startFrame: clip.startFrame, sourceInFrame: sourceIn, durationFrames: duration }, placement });
    }
  }, [current.values, source, fps, clip, onCommit, placement]);
  const changeTrack = React.useCallback((value: string): void => {
    if (value === clip.trackId) return;
    onCommit(value === 'new'
      ? { operation: 'move', parameters: { clipId: clip.id, startFrame: clip.startFrame, newTrackId: newId() }, placement }
      : { operation: 'move', parameters: { clipId: clip.id, startFrame: clip.startFrame, trackId: value }, placement });
  }, [clip, onCommit, placement]);

  /**
   * One numeric field, or its value as text when it cannot be edited.
   * @param name - The field.
   * @param label - Its label key.
   * @param editable - Whether it can be edited.
   * @returns The field.
   * @throws {never} Never.
   */
  function field(name: Field, label: string, editable: boolean): React.JSX.Element {
    const id = `timeline-clip-${name}-${spaceId}`;
    const testId = `timeline-clip-${name}`;
    return <div className='flex flex-col gap-1'>
      <Label htmlFor={editable ? id : undefined}>{t(label)}</Label>
      {editable
        ? <Input id={id} data-testid={testId} type='number' inputMode='numeric' autoComplete='off' step={1} value={current.values[name]} className='h-8 w-28'
          onChange={(event) => change(name, event.target.value)} onBlur={() => commit(name)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(name); } }} />
        : <span data-testid={testId} className='text-sm tabular-nums'>{current.values[name]}</span>}
      {name === 'start' && startLocked && !readOnly && <span className='text-2xs text-muted-foreground'>{t('timeline.edit.magnetStartHint')}</span>}
      {current.error === name && <span data-testid='timeline-clip-field-error' className='text-2xs text-status-error-foreground'>{t('timeline.errors.invalid_range')}</span>}
    </div>;
  }

  return <div className='flex flex-wrap items-start gap-4'>
    <div className='flex min-w-0 flex-col gap-1'>
      <span className='max-w-64 truncate font-medium leading-normal'>{name}</span>
      {conflict && <span className='text-status-error-foreground'>{t('timeline.conflict')}</span>}
    </div>
    <div className='flex flex-col gap-1'>
      <Label htmlFor={`timeline-clip-track-${spaceId}`}>{t('timeline.edit.track')}</Label>
      {readOnly
        ? <span data-testid='timeline-clip-track' className='text-sm'>{trackName ?? t('timeline.edit.trackRemoved')}</span>
        : <Select value={trackName === null ? '' : clip.trackId} onValueChange={changeTrack}>
          <SelectTrigger id={`timeline-clip-track-${spaceId}`} data-testid='timeline-clip-track' className='h-8 w-40'><SelectValue placeholder={t('timeline.edit.trackRemoved')} /></SelectTrigger>
          <SelectContent>{labels.visual.map((track) => <SelectItem key={track.id} value={track.id}>{track.label}</SelectItem>)}<SelectItem value='new'>{t('timeline.edit.newTrack')}</SelectItem></SelectContent>
        </Select>}
    </div>
    {field('start', 'timeline.startFrame', !readOnly && !startLocked)}
    {field('in', 'timeline.edit.inPoint', !readOnly)}
    {field('duration', 'timeline.edit.duration', !readOnly)}
  </div>;
}
