// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { newId, TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineVideoClip } from '@breatic/shared';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { parseTimelineFrame, timelineClipIntervalValid, timelineSourceOverflow } from '@web/data/yjs/timeline-time';

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

/** The clip property each field edits. */
const FRAME_OF = { start: 'startFrame', in: 'sourceInFrame', duration: 'durationFrames' } as const satisfies Record<Field, keyof TimelineVideoClip>;

/** One field's text, the stored value it was started from, and whether it was judged out of range. */
interface FieldDraft { stored: string; value: string; error: boolean }

/** The drafts of one clip's fields. */
interface Drafts { clipId: string; fields: Record<Field, FieldDraft> }

/**
 * The drafts for the stored clip: a field restarts from its stored value when that value changed or another clip
 * is shown, and keeps the user's text and note otherwise.
 * @param drafts - The current drafts, if any.
 * @param clip - The stored clip.
 * @returns The same drafts when nothing restarts, else new ones.
 * @throws {never} Never.
 */
function syncDrafts(drafts: Drafts | null, clip: TimelineVideoClip): Drafts {
  let changed = drafts?.clipId !== clip.id;
  const fields = {} as Record<Field, FieldDraft>;
  for (const field of Object.keys(FRAME_OF) as Field[]) {
    const stored = String(clip[FRAME_OF[field]]);
    const kept = drafts?.clipId === clip.id ? drafts.fields[field] : undefined;
    if (kept?.stored === stored) fields[field] = kept;
    else {
      fields[field] = { stored, value: stored, error: false };
      changed = true;
    }
  }
  return changed || drafts === null ? { clipId: clip.id, fields } : drafts;
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
  const [drafts, setDrafts] = React.useState(() => syncDrafts(null, clip));
  const current = syncDrafts(drafts, clip);
  if (current !== drafts) setDrafts(current);
  const source = document.sources[clip.sourceId];
  const fps = document.settings.fps;
  const startLocked = placement.magnet && clip.trackId === TIMELINE_MAIN_TRACK_ID;
  const trackName = labels.nameOf(clip.trackId);

  const update = React.useCallback((field: Field, patch: Partial<FieldDraft>): void => {
    setDrafts((previous) => ({ ...previous, fields: { ...previous.fields, [field]: { ...previous.fields[field], ...patch } } }));
  }, []);
  const change = React.useCallback((field: Field, value: string): void => update(field, { value, error: false }), [update]);
  // Each field is judged with the other fields' stored values: a valid entry commits on blur, so a draft left in
  // another field is one already judged out of range.
  const commit = React.useCallback((field: Field): void => {
    const frame = parseTimelineFrame(current.fields[field].value);
    const range = { ...clip, [FRAME_OF[field]]: frame };
    const valid = timelineClipIntervalValid(range)
      && (field === 'start' || source === undefined || timelineSourceOverflow(range, source, fps) === 0);
    if (!valid) { update(field, { error: true }); return; }
    if (frame === clip[FRAME_OF[field]]) return;
    onCommit(field === 'start'
      ? { operation: 'move', parameters: { clipId: clip.id, startFrame: frame }, placement }
      : { operation: 'set_range', parameters: { clipId: clip.id, startFrame: clip.startFrame, sourceInFrame: range.sourceInFrame, durationFrames: range.durationFrames }, placement });
  }, [current.fields, source, fps, clip, onCommit, placement, update]);
  const changeTrack = React.useCallback((value: string): void => {
    if (value === clip.trackId) return;
    onCommit(value === 'new'
      ? { operation: 'move', parameters: { clipId: clip.id, startFrame: clip.startFrame, newTrackId: newId() }, placement }
      : { operation: 'move', parameters: { clipId: clip.id, startFrame: clip.startFrame, trackId: value }, placement });
  }, [clip, onCommit, placement]);

  /**
   * One numeric field, or its value as text when it cannot be edited.
   * @param which - The field.
   * @param label - Its label key.
   * @param editable - Whether it can be edited.
   * @returns The field.
   * @throws {never} Never.
   */
  function field(which: Field, label: string, editable: boolean): React.JSX.Element {
    const id = `timeline-clip-${which}-${spaceId}`;
    const testId = `timeline-clip-${which}`;
    return <div className='flex flex-col gap-1'>
      <Label htmlFor={editable ? id : undefined}>{t(label)}</Label>
      {editable
        ? <Input id={id} data-testid={testId} type='number' inputMode='numeric' autoComplete='off' step={1} value={current.fields[which].value} className='h-8 w-28'
          onChange={(event) => change(which, event.target.value)} onBlur={() => commit(which)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(which); } }} />
        : <span data-testid={testId} className='text-sm tabular-nums'>{current.fields[which].value}</span>}
      {which === 'start' && startLocked && !readOnly && <span className='text-2xs text-muted-foreground'>{t('timeline.edit.magnetStartHint')}</span>}
      {current.fields[which].error && <span data-testid='timeline-clip-field-error' className='text-2xs text-status-error-foreground'>{t('timeline.errors.invalid_range')}</span>}
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
