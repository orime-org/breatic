// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { newId, TIMELINE_MAIN_TRACK_ID, type TimelineClip, type TimelineDocumentV1 } from '@breatic/shared';
import { EMPTY_TIMELINE_WEB_RESOLUTION, resolveTimelineClipExtent, type TimelineArrangementReason, type TimelineWebResolution } from '@web/data/yjs/timeline-arrangement';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { parseTimelineFrame, timelineClipIntervalValid, timelineSourceOverflow } from '@web/data/yjs/timeline-time';

import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import type { TimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';

/** The selected clip's editable properties. */
interface TimelineClipPropertiesProps {
  spaceId: string;
  document: TimelineDocumentV1;
  web?: TimelineWebResolution;
  clip: TimelineClip;
  name: string;
  /** The request a web-animation copy came from. */
  request?: string | null;
  conflict: boolean;
  reason?: TimelineArrangementReason['code'] | null;
  labels: TimelineTrackLabels;
  readOnly: boolean;
  placement: TimelineEditPlacement;
  onCommit: (command: TimelineEditCommand) => void;
}

type Field = 'start' | 'in' | 'duration';

const LABEL = 'text-xs text-muted-foreground';

/** The clip property each field edits. */
const FRAME_OF = { start: 'startFrame', in: 'sourceInFrame', duration: 'durationFrames' } as const satisfies Record<Field, keyof TimelineClip>;

/** One field's text, the stored value it was started from, and whether it was judged out of range. */
interface FieldDraft { stored: string; value: string; error: boolean }

/** The drafts of the shown clip's fields; the panel is keyed by clip, so another clip starts with new drafts. */
type Drafts = Record<Field, FieldDraft>;

/**
 * The drafts for the stored clip: a field keeps the user's text and note while it can be edited and its stored value
 * is unchanged, and shows its stored value otherwise.
 * @param drafts - The current drafts, if any.
 * @param clip - The stored clip.
 * @param editable - Which fields can be edited now.
 * @returns The same drafts when nothing restarts, else new ones.
 * @throws {never} Never.
 */
function syncDrafts(drafts: Drafts | null, clip: TimelineClip, editable: Readonly<Record<Field, boolean>>): Drafts {
  let changed = false;
  const next = {} as Drafts;
  for (const field of Object.keys(FRAME_OF) as Field[]) {
    const stored = String(clip[FRAME_OF[field]]);
    const kept = drafts?.[field];
    if (kept?.stored === stored && (editable[field] || (kept.value === stored && !kept.error))) next[field] = kept;
    else {
      next[field] = { stored, value: stored, error: false };
      changed = true;
    }
  }
  return changed || drafts === null ? next : drafts;
}

/**
 * Track, start, in-point and duration of the selected clip, and its video's length, or for a web-animation copy the
 * request it came from; edits commit on Enter or blur.
 * @param props - The clip, its context and the commit callback.
 * @param props.spaceId - The Space, for field ids.
 * @param props.document - The current Timeline, for the clip's source extent.
 * @param props.web - The resolution of web references, for a web copy's extent.
 * @param props.clip - The selected clip.
 * @param props.name - Its display name.
 * @param props.request - The request a web copy came from, when known.
 * @param props.conflict - Whether the arrangement reports a conflict.
 * @param props.reason - The first reason it conflicts, if any (only a conflicting clip has one).
 * @param props.labels - Track names.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.placement - The editing user's switches.
 * @param props.onCommit - Commits an edit.
 * @returns The properties fields.
 * @throws {never} Never.
 */
export function TimelineClipProperties({ spaceId, document, web = EMPTY_TIMELINE_WEB_RESOLUTION, clip, name, request = null, conflict, reason = null, labels, readOnly, placement, onCommit }: TimelineClipPropertiesProps): React.JSX.Element {
  const t = useTranslation();
  const startLocked = placement.magnet && clip.trackId === TIMELINE_MAIN_TRACK_ID;
  const editable = React.useMemo(() => ({ start: !readOnly && !startLocked, in: !readOnly, duration: !readOnly }), [readOnly, startLocked]);
  const [drafts, setDrafts] = React.useState(() => syncDrafts(null, clip, editable));
  const current = syncDrafts(drafts, clip, editable);
  if (current !== drafts) setDrafts(current);
  const source = resolveTimelineClipExtent(document, web, clip);
  const fps = document.settings.fps;
  const trackName = labels.nameOf(clip.trackId);

  const update = React.useCallback((field: Field, patch: Partial<FieldDraft>): void => {
    setDrafts((previous) => ({ ...previous, [field]: { ...previous[field], ...patch } }));
  }, []);
  const change = React.useCallback((field: Field, value: string): void => update(field, { value, error: false }), [update]);
  // Each field is judged with the other fields' stored values: an entry in range is committed and its field shows the
  // stored value again (the new one, or the old one with a toast when refused), so a draft left in another field is
  // one judged out of range.
  const commit = React.useCallback((field: Field): void => {
    const frame = parseTimelineFrame(current[field].value);
    const range = { ...clip, [FRAME_OF[field]]: frame };
    const valid = timelineClipIntervalValid(range)
      && (field === 'start' || source === undefined || timelineSourceOverflow(range, source, fps) === 0);
    if (!valid) { update(field, { error: true }); return; }
    update(field, { value: current[field].stored, error: false });
    if (frame === clip[FRAME_OF[field]]) return;
    onCommit(field === 'start'
      ? { operation: 'move', parameters: { clipId: clip.id, startFrame: frame }, placement }
      : { operation: 'set_range', parameters: { clipId: clip.id, startFrame: clip.startFrame, sourceInFrame: range.sourceInFrame, durationFrames: range.durationFrames }, placement });
  }, [current, source, fps, clip, onCommit, placement, update]);
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
   * @returns The field.
   * @throws {never} Never.
   */
  function field(which: Field, label: string): React.JSX.Element {
    const id = `timeline-clip-${which}-${spaceId}`;
    const testId = `timeline-clip-${which}`;
    return <div className='flex flex-col gap-1'>
      <Label htmlFor={editable[which] ? id : undefined} className={LABEL}>{t(label)}</Label>
      {editable[which]
        ? <Input id={id} data-testid={testId} type='number' inputMode='numeric' autoComplete='off' step={1} value={current[which].value} className='h-8 w-full'
          aria-invalid={current[which].error} onChange={(event) => change(which, event.target.value)} onBlur={() => commit(which)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(which); } }} />
        : <span data-testid={testId} className={cn('flex h-8 items-center text-sm tabular-nums', !readOnly && 'px-3')}>{current[which].value}</span>}
      {which === 'start' && startLocked && !readOnly && <span className='text-xs text-muted-foreground'>{t('timeline.edit.magnetStartHint')}</span>}
      {current[which].error && <span data-testid='timeline-clip-field-error' className='text-xs text-status-error-foreground'>{t('timeline.errors.invalid_range')}</span>}
    </div>;
  }

  return <div className='flex flex-col gap-3'>
    <div className='flex min-w-0 flex-col gap-1'>
      <Tooltip>
        <TooltipTrigger asChild><span className='truncate text-sm font-semibold leading-normal'>{name}</span></TooltipTrigger>
        <TooltipContent portal className='max-w-sm break-all'>{name}</TooltipContent>
      </Tooltip>
      {request !== null && <span data-testid='timeline-clip-request' className='break-words text-xs text-muted-foreground'>{request}</span>}
      {conflict && <span className='flex min-w-0 gap-1 text-status-error-foreground'>
        <span className='shrink-0'>{t('timeline.conflict')}</span>
        {reason !== null && <><span className='shrink-0'>·</span><span className='min-w-0 truncate'>{t(`timeline.conflictReason.${reason}`)}</span></>}
      </span>}
    </div>
    <div className='flex flex-col gap-1'>
      <Label htmlFor={`timeline-clip-track-${spaceId}`} className={LABEL}>{t('timeline.edit.track')}</Label>
      {readOnly
        ? <span data-testid='timeline-clip-track' className='text-sm'>{trackName ?? t('timeline.edit.trackRemoved')}</span>
        : <Select value={trackName === null ? '' : clip.trackId} onValueChange={changeTrack}>
          <SelectTrigger id={`timeline-clip-track-${spaceId}`} data-testid='timeline-clip-track' className='h-8 w-full'><SelectValue placeholder={t('timeline.edit.trackRemoved')} /></SelectTrigger>
          <SelectContent>{labels.visual.map((track) => <SelectItem key={track.id} value={track.id}>{track.label}</SelectItem>)}<SelectItem value='new'>{t('timeline.edit.newTrack')}</SelectItem></SelectContent>
        </Select>}
    </div>
    {field('start', 'timeline.startFrame')}
    {field('in', 'timeline.edit.inPoint')}
    {field('duration', 'timeline.edit.duration')}
    {source !== undefined && clip.kind === 'video' && <span data-testid='timeline-clip-source' className='text-xs text-muted-foreground'>
      {t('timeline.sourceExtent', { frames: source.extentFrames, fps: Math.round(fps.num / fps.den * 100) / 100 })}</span>}
  </div>;
}
