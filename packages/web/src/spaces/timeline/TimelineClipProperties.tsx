// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import {
  newId, TIMELINE_MAIN_TRACK_ID, TIMELINE_MAX_GAIN, type TimelineClip, type TimelineDocumentV1, type TimelineWebResolution,
} from '@breatic/shared';
import { EMPTY_TIMELINE_WEB_RESOLUTION, resolveTimelineClipExtent } from '@web/data/yjs/timeline-arrangement';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { parseTimelineFrame, timelineClipIntervalValid, timelineSourceOverflow } from '@web/data/yjs/timeline-time';

import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Label } from '@web/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { Switch } from '@web/components/ui/switch';
import { Textarea } from '@web/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { timelineClipKind } from '@web/spaces/timeline/timeline-clip-name';
import type { TimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';
import { TimelineTransformFields } from '@web/spaces/timeline/TimelineTransformFields';

/** A web-animation copy's origin as its properties show it (#1490 design §8.1). */
export interface TimelineWebCopyDetails {
  /** The whole prompt or modification instruction, once resolved. */
  request: string | null;
  /** For a modification, the request of the result it started from. */
  baseRequest: string | null;
  /** Why its execution did not produce a result, when it did not. */
  failure: string | null;
  /** Opens the Motion Space that made it with its execution selected; null hides the button. */
  onOpenInMotion: (() => void) | null;
  /** Whether a Motion Space is being made to open it in. */
  opening: boolean;
}

/** Why a clip's file cannot be read, and what the user can do (inner#1709). */
export interface TimelineMediaIssue {
  text: string;
  /** The next step when it is to ask someone; null when it is a retry. */
  next: string | null;
  onRetry: (() => void) | null;
}

/** The selected clip's editable properties. */
interface TimelineClipPropertiesProps {
  spaceId: string;
  document: TimelineDocumentV1;
  web?: TimelineWebResolution;
  clip: TimelineClip;
  /** Whether the clip covers the current frame. */
  atFrame: boolean;
  name: string;
  /** What a web-animation copy came from, why it failed and how to open it in Motion. */
  webCopy?: TimelineWebCopyDetails | null;
  /** An upload placeholder's status line, and the retry this page can offer for it. */
  upload?: { text: string; failed: boolean; progress: number | null; onRetry: (() => void) | null } | null;
  /** Why its file cannot be read, when it cannot. */
  media?: TimelineMediaIssue | null;
  /** Focus the text body when the panel opens, as after adding a text (inner#1709). */
  focusBody?: boolean;
  /** Not read: conflicts are no longer shown (inner#1709). Accepted so earlier callers still type-check. */
  conflict?: boolean;
  labels: TimelineTrackLabels;
  readOnly: boolean;
  placement: TimelineEditPlacement;
  onCommit: (command: TimelineEditCommand) => void;
}

type Field = 'start' | 'in' | 'duration';

const LABEL = 'text-xs text-muted-foreground';
// The text body and size bounds of the clip schema (inner#1709).
const TEXT_BODY_MAX = 2000;
const TEXT_SIZE_MIN = 0.01;
const TEXT_SIZE_MAX = 0.5;
// The volume slider reaches the +12 dB ceiling in whole percent (design §6.5).
const GAIN_MAX_PERCENT = Math.floor(TIMELINE_MAX_GAIN * 100);

/**
 * Whether a clip kind has no in-point: a picture or a text, and a placeholder of a picture (design §3.3).
 * @param clip - The clip.
 * @returns Whether it is drawn from frame 0 whatever its length.
 * @throws {never} Never.
 */
function unbounded(clip: TimelineClip): boolean {
  const kind = timelineClipKind(clip);
  return kind === 'image' || kind === 'text';
}

/** A text clip's body and size fields (design §6.5). */
interface TextFieldsProps {
  spaceId: string;
  text: { body: string; size: number };
  frameHeight: number;
  readOnly: boolean;
  focusBody: boolean;
  onCommit: (text: { body: string; size: number }) => void;
}

/**
 * A text clip's body (multi-line, at most 2000 characters) and its size in whole pixels of the frame height, stored as
 * a share of it; each commits on leaving its field, the size also on Enter.
 * @param props - The fields.
 * @param props.spaceId - The Space, for field ids.
 * @param props.text - The stored text.
 * @param props.frameHeight - The frame height in pixels.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.focusBody - Whether the body takes focus when it mounts.
 * @param props.onCommit - Commits the whole text.
 * @returns The fields.
 * @throws {never} Never.
 */
function TextFields({ spaceId, text, frameHeight, readOnly, focusBody, onCommit }: TextFieldsProps): React.JSX.Element {
  const t = useTranslation();
  const storedPx = String(Math.round(text.size * frameHeight));
  const [body, setBody] = React.useState({ stored: text.body, value: text.body });
  const [size, setSize] = React.useState({ stored: storedPx, value: storedPx });
  // A field shows the stored value again once it changes elsewhere.
  if (body.stored !== text.body) setBody({ stored: text.body, value: text.body });
  if (size.stored !== storedPx) setSize({ stored: storedPx, value: storedPx });
  const changeBody = React.useCallback((event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = event.target.value.slice(0, TEXT_BODY_MAX);
    setBody((previous) => ({ ...previous, value }));
  }, []);
  const commitBody = React.useCallback((): void => {
    if (body.value.trim() === '') {
      setBody({ stored: text.body, value: text.body });
      toast.warning(t('timeline.text.bodyEmpty'));
      return;
    }
    if (body.value !== text.body) onCommit({ body: body.value, size: text.size });
  }, [body.value, text, onCommit, t]);
  const changeSize = React.useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.value.replace(/[^0-9]/g, '');
    setSize((previous) => ({ ...previous, value }));
  }, []);
  const commitSize = React.useCallback((): void => {
    const px = Number.parseInt(size.value, 10);
    if (!Number.isFinite(px)) { setSize({ stored: storedPx, value: storedPx }); return; }
    const bounded = Math.min(Math.floor(TEXT_SIZE_MAX * frameHeight), Math.max(Math.ceil(TEXT_SIZE_MIN * frameHeight), px));
    setSize({ stored: storedPx, value: String(bounded) });
    if (String(bounded) !== storedPx) onCommit({ body: text.body, size: bounded / frameHeight });
  }, [size.value, storedPx, frameHeight, text.body, onCommit]);
  const sizeKey = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commitSize();
  }, [commitSize]);
  return <>
    <div className='flex flex-col gap-1'>
      <Label htmlFor={`timeline-clip-text-body-${spaceId}`} className={LABEL}>{t('timeline.text.body')}</Label>
      <Textarea id={`timeline-clip-text-body-${spaceId}`} data-testid='timeline-clip-text-body' autoComplete='off' maxLength={TEXT_BODY_MAX} value={body.value}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- a text just added is typed into at once (design §6.3).
        autoFocus={focusBody} disabled={readOnly} className='min-h-20 resize-none' onChange={changeBody} onBlur={commitBody} />
    </div>
    <div className='flex flex-col gap-1'>
      <Label htmlFor={`timeline-clip-text-size-${spaceId}`} className={LABEL}>{t('timeline.text.size')}</Label>
      <Input id={`timeline-clip-text-size-${spaceId}`} data-testid='timeline-clip-text-size' type='text' inputMode='numeric' autoComplete='off' value={size.value}
        disabled={readOnly} className='h-8 w-full' onChange={changeSize} onBlur={commitSize} onKeyDown={sizeKey} />
    </div>
  </>;
}

/** A video's or sound's volume and mute (design §6.5). */
interface SoundFieldsProps { spaceId: string; gain: number; mute: boolean; readOnly: boolean; onCommit: (sound: { gain: number; mute: boolean }) => void }

/**
 * A volume slider from 0 to 398 percent, committed once on release, and a mute switch.
 * @param props - The fields.
 * @param props.spaceId - The Space, for field ids.
 * @param props.gain - The stored linear gain.
 * @param props.mute - Whether it is muted.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.onCommit - Commits gain and mute together.
 * @returns The fields.
 * @throws {never} Never.
 */
function SoundFields({ spaceId, gain, mute, readOnly, onCommit }: SoundFieldsProps): React.JSX.Element {
  const t = useTranslation();
  const storedPercent = Math.min(GAIN_MAX_PERCENT, Math.round(gain * 100));
  const [percent, setPercent] = React.useState({ stored: storedPercent, value: storedPercent });
  if (percent.stored !== storedPercent) setPercent({ stored: storedPercent, value: storedPercent });
  const value = React.useMemo(() => [percent.value], [percent.value]);
  const change = React.useCallback(([next = 0]: number[]): void => setPercent((previous) => ({ ...previous, value: next })), []);
  const commit = React.useCallback(([next = 0]: number[]): void => {
    if (next !== storedPercent) onCommit({ gain: Math.min(TIMELINE_MAX_GAIN, next / 100), mute });
  }, [storedPercent, mute, onCommit]);
  const toggleMute = React.useCallback((checked: boolean): void => onCommit({ gain, mute: checked }), [gain, onCommit]);
  // A Viewer reads the values as text, like every other field.
  if (readOnly) {
    return <div className='flex flex-col gap-1'>
      <span className={LABEL}>{t('timeline.audio.gain')}</span>
      <span data-testid='timeline-clip-gain' className='text-sm tabular-nums'>{mute ? t('timeline.audio.mute') : `${storedPercent}%`}</span>
    </div>;
  }
  return <>
    <div className='flex flex-col gap-1'>
      <span className={LABEL}>{t('timeline.audio.gain')}</span>
      <div data-testid='timeline-clip-gain' className='flex items-center gap-3'>
        <Slider aria-label={t('timeline.audio.gain')} value={value} min={0} max={GAIN_MAX_PERCENT} step={1} disabled={mute}
          onValueChange={change} onValueCommit={commit} className='min-w-0 flex-1' />
        <span className='w-11 shrink-0 text-right text-xs tabular-nums'>{`${percent.value}%`}</span>
      </div>
    </div>
    <div className='flex items-center gap-2'>
      <Switch id={`timeline-clip-mute-${spaceId}`} data-testid='timeline-clip-mute' checked={mute} onCheckedChange={toggleMute} />
      <Label htmlFor={`timeline-clip-mute-${spaceId}`} className='text-xs'>{t('timeline.audio.mute')}</Label>
    </div>
  </>;
}

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
 * Track, start, in-point and duration of the selected clip and its source's length, by kind (inner#1709):
 * a text's body and size, a video's or sound's volume and mute, a drawn clip's position and size, a web copy's request,
 * a placeholder's upload and why a file cannot be read; edits commit on Enter or blur.
 * @param props - The clip, its context and the commit callback.
 * @param props.spaceId - The Space, for field ids.
 * @param props.document - The current Timeline, for the clip's source extent.
 * @param props.web - The resolution of web references, for a web copy's extent.
 * @param props.clip - The selected clip.
 * @param props.atFrame - Whether it covers the current frame.
 * @param props.name - Its display name.
 * @param props.webCopy - What a web copy came from and why it failed.
 * @param props.upload - An upload placeholder's status and retry.
 * @param props.media - Why its file cannot be read.
 * @param props.focusBody - Whether a text's body takes focus when the panel opens.
 * @param props.labels - Track names.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.placement - The editing user's switches.
 * @param props.onCommit - Commits an edit.
 * @returns The properties fields.
 * @throws {never} Never.
 */
export function TimelineClipProperties({ spaceId, document, web = EMPTY_TIMELINE_WEB_RESOLUTION, clip, atFrame, name, webCopy = null, upload = null, media = null, focusBody = false, labels, readOnly, placement, onCommit }: TimelineClipPropertiesProps): React.JSX.Element {
  const t = useTranslation();
  const startLocked = placement.magnet && clip.trackId === TIMELINE_MAIN_TRACK_ID;
  const editable = React.useMemo(() => ({ start: !readOnly && !startLocked, in: !readOnly, duration: !readOnly }), [readOnly, startLocked]);
  const kind = timelineClipKind(clip);
  const [drafts, setDrafts] = React.useState(() => syncDrafts(null, clip, editable));
  const current = syncDrafts(drafts, clip, editable);
  if (current !== drafts) setDrafts(current);
  const source = resolveTimelineClipExtent(document, web, clip);
  const fps = document.settings.fps;
  const trackName = labels.nameOf(clip.trackId);

  const update = React.useCallback((field: Field, patch: Partial<FieldDraft>): void => {
    setDrafts((previous) => ({ ...previous, [field]: { ...previous[field], ...patch } }));
  }, []);
  // Frames are whole and never negative: the plain field keeps digits only, with no native spinner.
  const change = React.useCallback((field: Field, value: string): void => update(field, { value: value.replace(/[^0-9]/g, ''), error: false }), [update]);
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
  const commitTransform = React.useCallback((transform: TimelineClip['transform']): void => {
    onCommit({ operation: 'set_transform', parameters: { clipId: clip.id, transform }, placement });
  }, [clip.id, onCommit, placement]);
  const commitText = React.useCallback((text: { body: string; size: number }): void => {
    onCommit({ operation: 'set_text', parameters: { clipId: clip.id, text }, placement });
  }, [clip.id, onCommit, placement]);
  const commitSound = React.useCallback((sound: { gain: number; mute: boolean }): void => {
    onCommit({ operation: 'set_audio', parameters: { clipId: clip.id, ...sound }, placement });
  }, [clip.id, onCommit, placement]);
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
        ? <Input id={id} data-testid={testId} type='text' inputMode='numeric' autoComplete='off' value={current[which].value} className='h-8 w-full'
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
      {webCopy !== null && webCopy.request !== null && <span data-testid='timeline-clip-request' className='break-words text-xs text-muted-foreground'>{webCopy.request}</span>}
      {webCopy !== null && webCopy.baseRequest !== null && <span data-testid='timeline-web-base-request' className='break-words text-xs text-muted-foreground'>
        {t('timeline.webAnimation.modifiedFrom', { base: webCopy.baseRequest })}
      </span>}
      {webCopy !== null && webCopy.failure !== null && <span className='flex flex-col items-start gap-1.5'>
        <span data-testid='timeline-web-failure' className='break-words text-xs text-status-error-foreground'>{webCopy.failure}</span>
        {webCopy.onOpenInMotion !== null && <Button data-testid='timeline-web-open-in-motion' variant='outline' size='compact' loading={webCopy.opening} onClick={webCopy.onOpenInMotion}>{t('timeline.webAnimation.openInMotion')}</Button>}
      </span>}
      {upload !== null && <span className='flex min-w-0 items-center gap-2'>
        <span data-testid='timeline-clip-upload' className={cn('min-w-0 break-words text-xs', upload.failed ? 'text-status-error-foreground' : 'text-muted-foreground')}>{upload.text}</span>
        {upload.onRetry !== null && <Button data-testid='timeline-upload-retry' variant='outline' size='compact' onClick={upload.onRetry}>{t('timeline.retry')}</Button>}
      </span>}
      {upload !== null && upload.progress !== null && <span data-testid='timeline-upload-progress' role='progressbar' aria-valuenow={Math.round(upload.progress * 100)}
        aria-valuemin={0} aria-valuemax={100} className='h-1 w-full overflow-hidden rounded-full bg-muted'>
        <span className='block h-full bg-primary' style={{ width: `${Math.round(upload.progress * 100)}%` }} />
      </span>}
      {media !== null && <span data-testid='timeline-clip-media-issue' className='flex flex-col items-start gap-1.5 text-xs'>
        <span className='break-words text-status-error-foreground'>{media.text}</span>
        {media.next !== null && <span className='text-muted-foreground'>{media.next}</span>}
        {media.onRetry !== null && <Button data-testid='timeline-media-retry' variant='outline' size='compact' onClick={media.onRetry}>{t('timeline.retry')}</Button>}
      </span>}
    </div>
    {clip.kind === 'text' && <TextFields spaceId={spaceId} text={clip.text} frameHeight={document.settings.height} readOnly={readOnly} focusBody={focusBody} onCommit={commitText} />}
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
    {!unbounded(clip) && field('in', 'timeline.edit.inPoint')}
    {field('duration', 'timeline.edit.duration')}
    {(clip.kind === 'video' || clip.kind === 'audio') && <SoundFields spaceId={spaceId} gain={clip.gain} mute={clip.mute} readOnly={readOnly} onCommit={commitSound} />}
    {clip.kind !== 'upload' && clip.kind !== 'audio' && <TimelineTransformFields spaceId={spaceId} transform={clip.transform} frame={document.settings} atFrame={atFrame} readOnly={readOnly} onCommit={commitTransform} />}
    {unbounded(clip)
      ? <span data-testid='timeline-clip-source' className='text-xs text-muted-foreground'>{t('timeline.sourceExtent', { kind, frames: 0, fps: 0 })}</span>
      : source !== undefined && (clip.kind === 'video' || clip.kind === 'audio') && <span data-testid='timeline-clip-source' className='text-xs text-muted-foreground'>
        {t('timeline.sourceExtent', { kind, frames: source.extentFrames, fps: Math.round(fps.num / fps.den * 100) / 100 })}</span>}
  </div>;
}
