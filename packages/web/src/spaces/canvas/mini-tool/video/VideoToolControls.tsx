// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useVideoFrameThumbnails } from '@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { Skeleton } from '@web/components/ui/skeleton';
import { ArrowUpRight, AudioLines, Check, Film, MousePointer2, Plus, RefreshCw, RotateCcw, Scan, Square, Trash2, Users } from 'lucide-react';
import { newId, type ModelEntry } from '@breatic/shared';
import { lipsyncFailureRetryable, planVideoFrames, trackedMaskRetryable, planVideoSplit, type LipsyncFailureReason, type MiniToolAnalysisRecord, type VideoPlanGrid, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { frameIndexOfMediaTime, frameMidpointSeconds, gridDuration, gridFrameCovering, gridSeconds } from '@web/spaces/canvas/video-presentation/frame-grid-time';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { secondsLabel, useShownTime, VideoPlaybackStrip, type VideoPlaybackLiveClock } from '@web/spaces/canvas/mini-tool/video/VideoPlaybackStrip';
import type { SourceRangePlayback } from '@web/spaces/canvas/video-presentation/play-source-range';
import { Textarea } from '@web/components/ui/textarea';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useRunning } from '@web/stores/task-actions-in-flight';
import { SlotTool } from '@web/spaces/canvas/generate/generate-tools';
import { PreviewImg } from '@web/components/PreviewImg';
import { PARAM_OPTION_CLASS } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { EXPAND_RATIOS, frameForRatio } from '@web/spaces/canvas/mini-tool/expand-frame';
import { currentPeopleResult, editDialogue, overPeopleLimit, transitionHostInputId, type EraseTrackingStatus } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { ModeToggle } from '@web/spaces/canvas/generate/ModeToggle';

/** A duration range a lip-sync model accepts, both ends included (config `executions.video.lip-sync`). */
/** Lip-sync duration modes, named in English like every generation-panel value (web AGENTS "Product terms"). */
const SYNC_MODES = (['cut_off', 'silence', 'loop', 'bounce', 'remap'] as const).map((value) => ({ value, label: { cut_off: 'Cut off', silence: 'Silence', loop: 'Loop', bounce: 'Bounce', remap: 'Remap' }[value], testId: `video-sync-${value}` }));

export interface LipSyncDurationRange { minDurationSeconds: number; maxDurationSeconds: number }
/** The configured lip-sync models in order, the first the default, and the tracking model's range. */
export interface LipSyncChoices { models: (ModelEntry & LipSyncDurationRange)[]; tracking: LipSyncDurationRange; maxPeople?: number; maxDialogues?: number }

export interface VideoToolControlsProps<K extends VideoToolId = VideoToolId> {
  toolId: K;
  draft: VideoToolDraftById[K];
  onChange: (draft: VideoToolDraftById[K]) => void;
  analyses: readonly MiniToolAnalysisRecord[];
  previewSource?: VideoPresentationSource | null;
  /** The selected version's grid while the source is usable, otherwise null (frames-split §7.12). */
  grid: VideoPlanGrid | null;
  presentedTime: number | null;
  /** The source player's live clock, which the playback strip follows while the source plays. */
  liveClock?: VideoPlaybackLiveClock;
  disabled: boolean;
  pickingSlot: string | null;
  inputNames: ReadonlyMap<string, string>;
  onPick: (key: string) => void;
  onAnalyse: (kind: 'people' | 'scene_cuts' | 'tracked_mask') => void;
  /** Starts a new tracking run with a failed one's frozen input (execution design §10.3), leaving the draft as it is. */
  onRetryTracking?: (failed: MiniToolAnalysisRecord) => void;
  analysing: boolean;
  analysisCreditText?: string;
  /** What a finished tracking actually used, shown where its estimate was (canvas design §4 erase row). */
  analysisActualCreditText?: string;
  onEditTimeline: () => void;
  onInvalidChange?: (key: string, invalid: boolean) => void;
  onActiveDialogue?: (dialogueId: string) => void;
  onEndPick?: () => void;
  regionSelection?: 'rectangle' | 'point';
  onRegionSelection?: (selection: 'rectangle' | 'point') => void;
  onSeek?: (time: number) => void;
  /** Plays exactly one source range in the node's player (canvas design §4 split row preview). */
  onPlayRange?: (start: number, end: number) => SourceRangePlayback;
  sourceEpoch?: number;
  seekEpoch?: number;
  /** The lip-sync models to choose from and the tracking range. */
  lipSync?: LipSyncChoices;
  /** Why the last lip-sync run failed, per person and shared step (execution design §9.4). */
  lipSyncFailure?: LipsyncFailureReason | null;
  /** Retries the failed items of the last lip-sync run. */
  onRetryFailed?: () => void;
  /** That retry's press intent, which its button waits on. */
  retryIntent?: string;
  /** Why "Track selection" cannot track this selection now; a press shows it (execution design §10.2, §10.4). */
  trackBlockedReason?: string;
  /** Whether the erase tracking applies to the current selection, no longer applies, or has not been made. */
  trackingStatus?: EraseTrackingStatus;
  /** The source's display size an expansion's ratio frames wrap (the presentation's, sample aspect ratio applied). */
  expandSize?: { width: number; height: number };
  /** Opens the newest ready remove-background result of this source; absent while there is none. */
  onOpenResult?: () => void;
}

/** The tracking failure codes the panel names (execution design §10.3). */
const TRACKING_FAILURES = ['empty_foreground', 'tracking_output_mismatch', 'model_rejected', 'timeout', 'failed'] as const;

interface NumericProps {
  value: number;
  label: string;
  testId: string;
  min: number;
  max?: number;
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  disabled: boolean;
  onChange: (value: number) => void;
  onInvalidChange?: (key: string, invalid: boolean) => void;
  /** Called when the field loses focus; with it, Enter also leaves the field. */
  onSettle?: () => void;
  /** Whether leaving the field (blur or Enter) turns a number outside `[min, max]` into the nearest bound. */
  clampOnSettle?: boolean;
}

/**
 * Retains partial numeric edits while only committing valid persisted values.
 * @throws {never} Never.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoNumericInput(props: NumericProps): React.JSX.Element {
  const { value: persisted, testId, onInvalidChange } = props;
  const [text, setText] = React.useState(String(props.value));
  const written = React.useRef(props.value);
  const onChange = React.useRef(props.onChange);
  onChange.current = props.onChange;
  const shown = text.trim() === '' ? NaN : Number(text);
  const invalid = !Number.isFinite(shown) || shown < props.min || (props.exclusiveMin === true && shown === props.min) || (props.max !== undefined && (shown > props.max || props.exclusiveMax === true && shown === props.max));
  // The one writer: the shown number once it is accepted and not yet written, after a keystroke or after a limit moved
  // under refused text. Declared before the sync below, so in the commit where the stored value changes elsewhere the
  // shown text is not written back over it.
  React.useEffect(() => {
    if (!invalid && shown !== written.current) {
      written.current = shown;
      onChange.current(shown);
    }
  }, [invalid, shown]);
  React.useEffect(() => {
    if (persisted !== written.current) {
      written.current = persisted;
      setText(String(persisted));
    }
  }, [persisted]);
  // Reported under the field's current key whenever the shown text, a limit or the key changes, so a row that moves to
  // another position or a limit that moves under the text still blocks the run.
  React.useEffect(() => {
    onInvalidChange?.(testId, invalid);
    return () => onInvalidChange?.(testId, false);
  }, [onInvalidChange, testId, invalid]);
  const settles = props.onSettle !== undefined || props.clampOnSettle === true;
  /**
   * Turns a number outside the limits into the nearest bound when the field clamps. Tab and Enter run it while the field
   * still holds the focus: the write it causes can remount the owner's other controls, and a remount after focus has left
   * would send the focus to the dialog instead of the next control.
   * @throws {never} Never.
   */
  const clamp = (): void => {
    if (props.clampOnSettle === true && invalid && Number.isFinite(shown)) setText(String(Math.min(props.max ?? shown, Math.max(props.min, shown))));
  };
  /**
   * Leaves the field: the number is clamped, then the owner settles.
   * @throws {never} Never.
   */
  const settle = (): void => {
    clamp();
    props.onSettle?.();
  };
  return <Input type='text' inputMode='decimal' autoComplete='off' value={text} aria-label={props.label} data-testid={props.testId} aria-invalid={invalid} disabled={props.disabled} className='h-[var(--control-height)] min-w-0 px-2 text-xs tabular-nums md:text-xs' onBlur={settles ? settle : undefined} onKeyDown={(event) => {
    if (event.key === 'Tab') clamp();
    if (event.key === 'Enter' && settles) { clamp(); event.currentTarget.blur(); }
  }} onChange={(event) => setText(event.currentTarget.value)} />;
}

/**
 * Uses registered thumbnail artifacts for person identities.
 * @throws {never} Never.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
function PeopleDialogues(props: VideoToolControlsProps): React.JSX.Element {
  const t = useTranslation();
  const draft = props.draft as VideoToolDraftById['video.lip-sync'];
  const [open, setOpen] = React.useState(false);
  useFollowCanvasViewport(open);
  const record = latestMiniToolAnalysis(props.analyses.filter((item) => item.kind === 'people'));
  // Only the newest identification counts: a running or failed re-detect hides the earlier people (demo redetectPatch).
  const result = currentPeopleResult(props.analyses);
  const people = result?.people ?? [];
  const ready = result !== undefined;
  const failed = record?.status === 'failed';
  const rows = draft.params.dialogues;
  const maxPeople = props.lipSync?.maxPeople;
  const maxDialogues = props.lipSync?.maxDialogues;
  const rowsFull = maxDialogues !== undefined && rows.length >= maxDialogues;
  /**
   * Commits all rows atomically without collapsing repeated people.
   * @throws {never} Never.
   * @param next - The complete next snapshot or sequence.
   */
  function changeRows(next: typeof rows): void {
    const referenced = new Set(next.map((row) => row.audioInputId));
    props.onChange({ ...draft, inputs: draft.inputs.filter((input) => referenced.has(input.inputId)), params: { ...draft.params, dialogues: next } });
  }
  // The start fields whose text is not a time of 0 s or later, each said under its own row (demo DialogueStartTime).
  const [invalidStarts, setInvalidStarts] = React.useState<ReadonlySet<string>>(new Set());
  const { onInvalidChange } = props;
  /**
   * Records a start field's validity for its row and reports it to the panel.
   * @param key - The field's test id.
   * @param invalid - Whether its text is invalid.
   * @throws {never} Never.
   */
  const startInvalidChange = React.useCallback((key: string, invalid: boolean): void => {
    setInvalidStarts((before) => before.has(key) === invalid ? before : new Set(invalid ? [...before, key] : [...before].filter((item) => item !== key)));
    onInvalidChange?.(key, invalid);
  }, [onInvalidChange]);
  return <section className='grid min-w-0 gap-2.5' data-testid='video-lip-sync-controls'>
    <div className='flex items-center justify-between gap-3'>
      <span className='flex items-center gap-1.5 text-xs font-medium'><Users className='size-3.5' aria-hidden='true' />{t('canvas.miniTool.videoUI.dialoguePairs')}</span>
      <Button variant='outline' size='compact' data-testid='video-identify-people' loading={props.analysing} disabled={props.disabled || props.analysing} icon={<RefreshCw className='size-3' />} onClick={() => props.onAnalyse('people')}>{t(failed ? 'canvas.miniTool.videoUI.retryPeople' : 'canvas.miniTool.videoUI.redetectPeople')}{props.analysisCreditText === undefined ? null : <span className='text-xs text-muted-foreground'>{props.analysisCreditText}</span>}</Button>
    </div>
    {ready && people.length > 0 && !props.analysing ? null : <p className={`rounded-chrome border p-2.5 text-xs ${failed && !props.analysing ? 'border-status-error text-status-error-foreground' : 'border-border text-muted-foreground'}`}>{props.analysing ? t('canvas.miniTool.videoUI.identifyingPeople') : failed ? t('canvas.miniTool.videoUI.peopleIdentificationFailed') : ready ? t('canvas.miniTool.videoUI.peopleEmpty') : t('canvas.miniTool.videoUI.peopleIdle')}</p>}
    <div className='grid grid-cols-[max-content_minmax(0,1fr)_8ch_24px] items-center gap-x-2 gap-y-1.5'>
      <span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.targetPerson')}</span><span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.dialogueAudio')}</span><span className='whitespace-nowrap text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.dialogueStartTime')}</span><span />
      {rows.map((row, index) => {
        const input = draft.inputs.find((item) => item.inputId === row.audioInputId);
        const selected = row.analysisRunId === result?.analysisRunId ? people.find((person) => person.personId === row.personId) : undefined;
        const startKey = `video-start-${row.dialogueId}`;
        const thumbnail = selected?.artifactRefs.find((artifact) => artifact.role === 'thumbnail')?.canonicalURL;
        const slotKey = `dialogue:${row.dialogueId}`;
        return <div key={row.dialogueId} className='col-span-4 grid grid-cols-subgrid items-center gap-x-2 gap-y-1.5' data-testid={`video-dialogue-${row.dialogueId}`} onFocusCapture={() => props.onActiveDialogue?.(row.dialogueId)}>
          <Select onOpenChange={setOpen} value={selected?.personId ?? ''} disabled={props.disabled || props.analysing || !ready || people.length === 0} onValueChange={(personId) => {
            if (overPeopleLimit(rows, row.dialogueId, personId, maxPeople)) { toast.warning(t('server.mini_tool.lipSyncTooManyPeople', { max: maxPeople ?? 0 })); return; }
            changeRows(editDialogue(rows, row.dialogueId, { personId, analysisRunId: result?.analysisRunId ?? null }));
          }}>
            <SelectTrigger data-testid={`video-person-${row.dialogueId}`} className='w-auto gap-1.5 px-2 text-xs'><span className='relative size-5 shrink-0 overflow-hidden rounded-content-xs bg-muted'>{thumbnail === undefined ? <Users className='size-5 text-muted-foreground' /> : <img src={thumbnail} alt='' className='size-full object-cover' />}</span><span className='min-w-0 truncate'><SelectValue placeholder={t('canvas.miniTool.videoUI.choosePerson')} /></span></SelectTrigger>
            <SelectContent avoidCollisions={false}>{people.map((person, personIndex) => { const capped = overPeopleLimit(rows, row.dialogueId, person.personId, maxPeople); return <SelectItem key={person.personId} value={person.personId} aria-disabled={capped ? true : undefined} className='aria-disabled:opacity-50'>{t('canvas.miniTool.videoUI.personNumber', { number: personIndex + 1 })}{capped ? <span className='ml-2 text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.personCapReached', { count: maxPeople ?? 0 })}</span> : null}</SelectItem>; })}</SelectContent>
          </Select>
          <div className={'min-w-0 [&>div]:min-w-0 [&>div>button:first-child]:h-[var(--control-height)] [&>div>button:first-child]:w-full [&>div>button:first-child]:min-w-0 [&>div>button:first-child]:flex-row [&>div>button:first-child]:justify-start [&>div>button:first-child]:gap-1.5 [&>div>button:first-child]:pr-6 [&>div>button:first-child>span]:truncate [&>div>button[aria-pressed=false]]:border-border [&>div>button[aria-pressed=true]]:border-active-border [&>div>button[aria-pressed=true]]:bg-accent [&>div>button[aria-pressed=true]]:text-foreground' + (input === undefined ? '' : ' [&>div>button:first-child>svg]:hidden [&>div>button:first-child]:pl-2')}>
            <SlotTool testId={`video-audio-${row.dialogueId}`} thumbnailTestId={`video-audio-thumbnail-${row.dialogueId}`} clearTestId={`video-audio-clear-${row.dialogueId}`} Icon={AudioLines} onPick={() => props.onPick(slotKey)} active={props.pickingSlot === slotKey} pick={input === undefined ? undefined : { kind: 'audio', url: input.url }} disabled={props.disabled} onClear={() => { if (props.pickingSlot === slotKey) props.onEndPick?.(); changeRows(editDialogue(rows, row.dialogueId, { audioInputId: null })); }} clearLabel={t('canvas.miniTool.panel.clearSlot')} label={input === undefined ? t('canvas.miniTool.videoUI.chooseDialogueAudio') : props.inputNames.get(input.inputId) ?? input.url.split('/').at(-1) ?? ''} tip={t('canvas.miniTool.videoUI.pickAudio')} />
          </div>
          <div className='flex min-w-0 items-center gap-1'><VideoNumericInput value={row.startTime} label={`${t('canvas.miniTool.videoUI.dialogueStartTime')} ${index + 1}`} testId={startKey} min={0} disabled={props.disabled} onInvalidChange={startInvalidChange} onChange={(startTime) => changeRows(editDialogue(rows, row.dialogueId, { startTime }))} /><span className='text-xs text-muted-foreground'>s</span></div>
          <Button variant='ghost' size='compact' className='size-6 px-0' disabled={props.disabled} aria-label={t('canvas.miniTool.videoUI.removeDialogue')} onClick={() => { if (props.pickingSlot === slotKey) props.onEndPick?.(); changeRows(rows.length > 1 ? rows.filter((item) => item.dialogueId !== row.dialogueId) : [{ dialogueId: newId(), personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }]); }}><Trash2 className='size-3.5' /></Button>
          {invalidStarts.has(startKey) ? <p className='col-span-4 text-right text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.dialogueStartInvalid')}</p> : null}
        </div>;
      })}
    </div>
    <Button variant='outline' size='compact' className='w-fit aria-disabled:opacity-50' disabled={props.disabled || props.analysing || !ready || people.length === 0} aria-disabled={rowsFull ? true : undefined} onClick={() => {
      if (rowsFull) { toast.warning(t('server.mini_tool.lipSyncTooManyDialogues', { max: maxDialogues })); return; }
      const dialogueId = newId();
      changeRows([...rows, { dialogueId, personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }]);
      // The new row is the active one, so the next box pressed on the node fills it (demo addDialogue).
      props.onActiveDialogue?.(dialogueId);
    }} icon={<Plus className='size-3.5' />}>{t('canvas.miniTool.videoUI.addDialogue')}</Button>
    <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.dialogueTimingHint')}</p>
    {/* Demo lip-sync-controls.tsx: the source's playback strip, on which people are identified, above the model row. */}
    <VideoPlaybackStrip src={draft.source.canonicalURL} duration={props.grid === null ? draft.source.mediaInfo.duration : gridDuration(props.grid)} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height}
      presentedTime={props.presentedTime} liveClock={props.liveClock} onSeek={props.onSeek} />
    {/* Canvas design §4 lip-sync row: the bottom row holds the model on the left and the duration mode on the right. */}
    <div data-testid='video-lipsync-bottom-row' className='flex items-center gap-1.5'>{props.lipSync === undefined || props.lipSync.models.length === 0 ? null : <ModelPicker models={props.lipSync.models} value={draft.params.modelId ?? props.lipSync.models[0].name} disabled={props.disabled} onChange={(modelId) => props.onChange({ ...draft, params: { ...draft.params, modelId } })} />}<ModeToggle value={draft.params.syncMode} options={SYNC_MODES} triggerTestId='video-sync-mode' disabled={props.disabled} onChange={(syncMode) => props.onChange({ ...draft, params: { ...draft.params, syncMode: syncMode as typeof draft.params.syncMode } })} /></div>
    {/* Hidden while identification restarts, as the demo's re-detect clears the failure (main.tsx person-failure-redetect). */}
    {props.lipSyncFailure && !props.analysing ? <LipSyncFailure reason={props.lipSyncFailure} disabled={props.disabled} onRetry={props.onRetryFailed} retryIntent={props.retryIntent} onRedetect={() => props.onAnalyse('people')} /> : null}
  </section>;
}

const PERSON_CATEGORY_KEYS = { no_face: 'personFailNoFace', model_rejected: 'personFailRejected', timeout: 'personFailTimeout', failed: 'personFailFailed', stopped: 'personFailStopped' } as const;
const PERSON_NEXT_KEYS = { no_face: 'personFailNoFaceNext', model_rejected: 'personFailRejectedNext', timeout: 'personFailRetryNext', failed: 'personFailRetryNext', stopped: 'personFailStoppedNext' } as const;
const SHARED_STEP_KEYS = { prepare: 'sharedFailPreparation', composite: 'sharedFailCompositing', stitch: 'sharedFailStitching', expired: 'sharedFailExpired' } as const;

/**
 * A failed lip-sync run (canvas design §4 lip-sync row, execution design §9.4): one line per person that did not succeed, by
 * detection number, with its category and next step, and one line for a failed shared step; once a person has no face or
 * was rejected, the other people and the shared step follow that person. Retry is offered only when the shared rule says every failure can
 * clear on a retry; with a person without a face, identifying people again is.
 * @param props - The reason and the actions.
 * @param props.reason - The failure reason.
 * @param props.disabled - Whether the panel takes edits.
 * @param props.onRetry - Retries the failed items; without it no retry is offered.
 * @param props.retryIntent - The retry's press intent, which the button waits on.
 * @param props.onRedetect - Identifies the people again, where the people are identified (the host's panel).
 * @returns The failure block.
 * @throws {z.ZodError} When the reason is malformed.
 */
export function LipSyncFailure(props: { reason: LipsyncFailureReason; disabled: boolean; onRetry?: () => void; retryIntent?: string; onRedetect?: () => void }): React.JSX.Element {
  const t = useTranslation();
  const retrying = Boolean(useRunning(props.retryIntent ?? ''));
  const { persons, shared } = props.reason;
  const blocker = persons.find((person) => person.category === 'no_face' || person.category === 'model_rejected')?.detectionNumber;
  // No retry is offered without a handler: the node hides it for an output a retry already took over (frames-split §7.15).
  const retryable = lipsyncFailureRetryable(props.reason) && props.onRetry !== undefined;
  const noFace = persons.some((person) => person.category === 'no_face');
  /**
   * A line's next step: a person or the shared step that a retry could clear follows the blocker once one exists.
   * @param category - The line's category.
   * @returns The next step.
   * @throws {never} Never.
   */
  const next = (category: keyof typeof PERSON_NEXT_KEYS): string => {
    const follows = blocker !== undefined && category !== 'no_face' && category !== 'model_rejected';
    return follows ? t(`canvas.miniTool.videoUI.${category === 'stopped' ? 'personFailStoppedNext' : 'personFailFollowNext'}`, { number: blocker }) : t(`canvas.miniTool.videoUI.${PERSON_NEXT_KEYS[category]}`);
  };
  return <div className='grid gap-2 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground' data-testid='video-lip-sync-failure'>
    <ul className='grid min-w-0 gap-1.5'>
      {persons.map((person) => <li key={person.personId} className='grid gap-0.5'><span className='font-medium'>{`${t('canvas.miniTool.videoUI.personNumber', { number: person.detectionNumber })} · ${t(`canvas.miniTool.videoUI.${PERSON_CATEGORY_KEYS[person.category]}`)}`}</span><span>{next(person.category)}</span></li>)}
      {shared === null ? null : <li className='grid gap-0.5'><span className='font-medium'>{t(`canvas.miniTool.videoUI.${SHARED_STEP_KEYS[shared.step]}`)}</span><span>{next(shared.category)}</span></li>}
    </ul>
    {retryable || (noFace && props.onRedetect !== undefined) ? <div className='flex justify-end'>{retryable
      ? <Button variant='outline' size='compact' loading={retrying} disabled={props.disabled} onClick={props.onRetry}>{t('canvas.miniTool.videoUI.retryFailedPeople')}</Button>
      : <Button variant='outline' size='compact' disabled={props.disabled} onClick={props.onRedetect}>{t('canvas.miniTool.videoUI.redetectPeople')}</Button>}</div> : null}
  </div>;
}

/**
 * Renders the approved parameter controls for the selected video tool.
 * @throws {Error} When a supplied grid or draft is malformed.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoToolControls(props: VideoToolControlsProps): React.JSX.Element {
  const t = useTranslation();
  const previewFrames = React.useMemo(() => {
    if (props.toolId !== 'video.extract-frames' || props.grid === null) return [];
    const draft = props.draft as VideoToolDraftById['video.extract-frames'];
    if (draft.params.mode === 'current' && props.presentedTime === null) return [];
    const request = draft.params.mode === 'current' && props.presentedTime !== null ? { ...draft.params, frameIndex: frameIndexOfMediaTime(props.presentedTime, props.grid) } : draft.params;
    return planVideoFrames(props.grid, request).map((frame) => frame.frameIndex);
  }, [props.toolId, props.grid, props.draft, props.presentedTime]);
  switch (props.toolId) {
    case 'video.expand': {
      const draft = props.draft as VideoToolDraftById['video.expand'];
      // Demo outpaint-controls.tsx: the image Expand panel's structure, its ratio heading over the grid.
      return <><div><p className='mb-1.5 text-xs font-medium text-muted-foreground'>{t('canvas.miniTool.param.aspect.label')}</p><div className='grid grid-cols-4 gap-1.5' data-testid='video-expand-ratios'>{EXPAND_RATIOS.map((ratio) => <Button key={ratio} variant={null} size={null} disabled={props.disabled} aria-current={draft.params.ratio === ratio} className={PARAM_OPTION_CLASS} onClick={() => props.onChange({ ...draft, params: { ...draft.params, ratio, frame: frameForRatio(ratio, props.expandSize ?? draft.source.mediaInfo, draft.params.frame) } })}>{ratio === 'free' ? 'Free' : ratio}</Button>)}</div></div><Textarea autoComplete='off' value={draft.params.prompt} disabled={props.disabled} placeholder={t('canvas.miniTool.videoUI.expandPrompt')} onChange={(event) => props.onChange({ ...draft, params: { ...draft.params, prompt: event.currentTarget.value } })} /></>;
    }
    case 'video.lip-sync': return <PeopleDialogues {...props} />;
    case 'video.erase': {
      const draft = props.draft as VideoToolDraftById['video.erase'];
      // The last tracking's failure, named by its stored code (execution design §10.3 code table).
      const tracking = latestMiniToolAnalysis(props.analyses.filter((record) => record.kind === 'tracked_mask'));
      const code = tracking?.status === 'failed' ? tracking.error?.code : undefined;
      const trackingFailure = typeof code === 'string' ? TRACKING_FAILURES.find((known) => known === code) ?? 'failed' : null;
      const range = draft.params.range;
      const hasSelection = draft.params.region.box !== null || draft.params.region.points.length > 0;
      const grid = props.grid;
      // The range is grid frames; the strip and the fields show it in seconds (frames-split §7.16 range row).
      const shownRange = grid === null ? null : { start: gridSeconds(grid, range.start), end: gridSeconds(grid, range.end) };
      /**
       * Commits a new range, given in seconds, as the grid frames it covers.
       * @param next - The range.
       * @param next.start - Its start in seconds.
       * @param next.end - Its end in seconds.
       * @throws {Error} When the edited draft fails its schema.
       */
      const setRange = (next: { start: number; end: number }): void => {
        if (grid === null) return;
        const start = Math.min(grid.frameCount - 1, Math.max(0, Math.round(next.start * grid.fps.numerator / grid.fps.denominator)));
        const end = Math.min(grid.frameCount, Math.max(start + 1, Math.round(next.end * grid.fps.numerator / grid.fps.denominator)));
        props.onChange({ ...draft, params: { ...draft.params, range: { start, end } } });
      };
      // Demo main.tsx erase branch: the range strip, the tracking status, one row with the selection modes and clear on the
      // left and the tracking cost and Track selection on the right, then the prompt.
      return <>
        <VideoPlaybackStrip src={draft.source.canonicalURL} duration={grid === null ? draft.source.mediaInfo.duration : gridDuration(grid)} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} presentedTime={props.presentedTime} liveClock={props.liveClock} onSeek={props.onSeek}
          {...(shownRange === null ? {} : { range: shownRange, onRangeChange: setRange, rangeLabel: t('canvas.miniTool.videoUI.timeRange') })} {...(grid === null ? {} : { rangeStep: gridSeconds(grid, 1) })} disabled={props.disabled} />
        {shownRange === null || grid === null ? null : <div className='grid grid-cols-2 gap-2'>
          <label className='grid gap-1 text-xs'>{t('canvas.miniTool.videoUI.rangeStart')}<VideoNumericInput value={shownRange.start} label={t('canvas.miniTool.videoUI.rangeStart')} testId='video-range-start' exclusiveMax min={0} max={shownRange.end} disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(start) => setRange({ ...shownRange, start })} /></label>
          <label className='grid gap-1 text-xs'>{t('canvas.miniTool.videoUI.rangeEnd')}<VideoNumericInput value={shownRange.end} label={t('canvas.miniTool.videoUI.rangeEnd')} testId='video-range-end' exclusiveMin min={shownRange.start} max={gridDuration(grid)} disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(end) => setRange({ ...shownRange, end })} /></label>
        </div>}
        <div data-testid='video-tracking-status' className='flex items-center gap-2 text-xs text-muted-foreground'><span aria-hidden='true' className={`size-2 shrink-0 rounded-full ${props.trackingStatus === 'tracked' ? 'bg-status-success' : 'bg-muted-foreground'}`} /><span>{t(props.trackingStatus === 'tracked' ? 'canvas.miniTool.videoUI.trackingReview' : props.trackingStatus === 'stale' ? 'canvas.miniTool.videoUI.trackingStale' : 'canvas.miniTool.videoUI.drawBox')}</span></div>
        <div data-testid='video-selection-row' className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-1'>
            {([['rectangle', Square], ['point', MousePointer2]] as const).map(([mode, Icon]) => <Button key={mode} variant={null} size={null} data-testid={`video-region-selection-${mode}`} aria-current={(props.regionSelection ?? 'rectangle') === mode} disabled={props.disabled} className={`${PARAM_OPTION_CLASS} gap-1`} onClick={() => props.onRegionSelection?.(mode)}><Icon className='size-3' aria-hidden='true' />{t(`canvas.miniTool.videoUI.${mode}`)}</Button>)}
            <Button variant='ghost' size='compact' aria-label={t('canvas.miniTool.videoUI.clearSelection')} disabled={props.disabled || !hasSelection} onClick={() => props.onChange({ ...draft, params: { ...draft.params, region: { box: null, points: [] } } })}><RotateCcw className='size-3.5' /></Button>
          </div>
          <div className='ml-auto flex items-center gap-2'>
            {props.analysisActualCreditText !== undefined ? <span className='whitespace-nowrap text-xs tabular-nums text-muted-foreground'>{t('canvas.miniTool.videoUI.trackingActual', { credits: props.analysisActualCreditText })}</span> : props.analysisCreditText === undefined ? null : <span className='whitespace-nowrap text-xs tabular-nums text-muted-foreground'>{t('canvas.miniTool.videoUI.trackingEstimate', { credits: props.analysisCreditText })}</span>}
            <Button variant='outline' size='sm' loading={props.analysing} icon={<Scan className='size-3.5' />} aria-disabled={props.trackBlockedReason === undefined ? undefined : true} disabled={props.disabled || props.analysing || !hasSelection} className='aria-disabled:opacity-50' onClick={() => { if (props.trackBlockedReason !== undefined) toast.warning(props.trackBlockedReason); else props.onAnalyse('tracked_mask'); }}>{t('canvas.miniTool.videoUI.trackObject')}</Button>
          </div>
        </div>
        {trackingFailure === null ? null : <div data-testid='video-tracking-failure' className='flex items-center justify-between gap-3 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground'><span>{t(`canvas.miniTool.videoUI.trackingFailure.${trackingFailure}`)}</span>{trackedMaskRetryable(trackingFailure) ? <Button variant='outline' size='compact' loading={props.analysing} disabled={props.disabled || props.analysing} onClick={() => props.onRetryTracking?.(tracking!)}>{t('canvas.miniTool.videoUI.retryTracking')}</Button> : null}</div>}
        <Textarea autoComplete='off' value={draft.params.trackingPrompt} disabled={props.disabled} placeholder={t('canvas.miniTool.videoUI.trackingPrompt')} onChange={(event) => props.onChange({ ...draft, params: { ...draft.params, trackingPrompt: event.currentTarget.value } })} />
      </>;
    }
    case 'video.remove-bg': {
      const draft = props.draft as VideoToolDraftById['video.remove-bg'];
      // Canvas design §4 remove-background row: the source preview, the fixed kept audio and transparent output, and the newest ready result.
      return <><VideoPlaybackStrip src={draft.source.canonicalURL} duration={props.grid === null ? draft.source.mediaInfo.duration : gridDuration(props.grid)} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} presentedTime={props.presentedTime} liveClock={props.liveClock} onSeek={props.onSeek} /><div className='flex items-center justify-between text-xs'><span>{t('canvas.miniTool.videoUI.preserveAudio')}</span><Check className='size-3.5 text-status-success' aria-hidden='true' /></div><p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.transparentOutput')}</p>{props.onOpenResult === undefined ? null : <Button variant='outline' size='sm' className='gap-1.5' onClick={props.onOpenResult}>{t('canvas.miniTool.videoUI.resultsReady')}<ArrowUpRight className='size-3.5' aria-hidden='true' /></Button>}</>;
    }
    case 'video.extract-frames': {
      const draft = props.draft as VideoToolDraftById['video.extract-frames'];
      const planned = previewFrames;
      /**
       * Chooses a frame mode; Current takes the presented time and waits for one.
       * @param mode - The mode.
       * @throws {never} Never.
       */
      const choose = (mode: typeof draft.params.mode): void => {
        if (mode === 'current' && (props.presentedTime === null || props.grid === null)) return;
        props.onChange({ ...draft, params: { ...draft.params, mode, ...(mode === 'current' && props.presentedTime !== null && props.grid !== null ? { frameIndex: frameIndexOfMediaTime(props.presentedTime, props.grid) } : {}) } });
      };
      // Canvas design §4 frames row: three equal buttons in one row; while the grid is not usable the panel shows only
      // its ledger line (frames-split §10.6), and the modes stay usable (only Run waits).
      return <><div className='grid grid-cols-3 gap-1.5' data-testid='video-frame-modes'>{(['first', 'last', 'current'] as const).map((mode) => <Button key={mode} variant={null} size={null} data-testid={`video-frame-mode-${mode}`} aria-current={draft.params.mode === mode} disabled={props.disabled || mode === 'current' && props.presentedTime === null} className={PARAM_OPTION_CLASS} onClick={() => choose(mode)}>{t(`canvas.miniTool.videoUI.${mode}`)}</Button>)}</div>{props.grid === null ? null : <>{draft.params.mode === 'current' && props.presentedTime === null ? <p className='text-center text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.currentFrameUnavailable')}</p> : null}<VideoFramePreview source={props.previewSource ?? null} grid={props.grid} frames={planned} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} onSeek={props.onSeek} /></>}</>;
    }
    case 'video.transitions': {
      const draft = props.draft as VideoToolDraftById['video.transitions'];
      // One input slot (canvas design invariant 11.2): it holds the input that is not the current video.
      const hostId = transitionHostInputId(draft);
      const input = draft.inputs.find((item) => item.inputId !== hostId);
      return <><span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.videoInputs')}</span><div className='flex flex-wrap gap-2'><SlotTool testId='video-timeline-input' thumbnailTestId='video-timeline-thumbnail' clearTestId='video-timeline-clear' Icon={Film} onPick={() => props.onPick('timeline')} active={props.pickingSlot === 'timeline'} pick={input === undefined ? undefined : { kind: 'video', url: input.url, thumbnail: input.cover }} disabled={props.disabled} onClear={() => { if (input === undefined) return; if (props.pickingSlot === 'timeline') props.onEndPick?.(); props.onChange({ ...draft, inputs: draft.inputs.filter((item) => item.inputId !== input.inputId), params: { clips: draft.params.clips.filter((clip) => clip.inputId !== input.inputId) } }); }} clearLabel={t('canvas.miniTool.panel.clearSlot')} label={input === undefined ? t('canvas.miniTool.videoUI.addVideoSlot') : props.inputNames.get(input.inputId) ?? t('canvas.miniTool.videoUI.video')} tip={t('canvas.miniTool.videoUI.pickVideo')} /></div><p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.timelineSlotHint')}</p>
        {/* What Run will join, in timeline order (tools design §4 transitions row: the two clips' summary). */}
        <div className='grid gap-2'>{draft.params.clips.map((clip, index) => { const clipInput = draft.inputs.find((item) => item.inputId === clip.inputId); return <div key={clip.clipId} data-testid='video-timeline-clip-summary' className='flex items-center gap-2 rounded-chrome border border-border p-2 text-xs'>{clipInput?.cover === undefined ? <Film className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' /> : <PreviewImg src={clipInput.cover} alt='' className='h-8 w-14 shrink-0 rounded-content-xs object-cover' />}<span className='min-w-0 flex-1 truncate'>{index + 1} · {props.inputNames.get(clip.inputId) ?? t('canvas.miniTool.videoUI.video')}</span><span className='shrink-0 tabular-nums text-muted-foreground'>{(clip.out - clip.in).toFixed(2)} s</span></div>; })}</div>
        {input === undefined ? null : <Button variant='outline' size='sm' onClick={props.onEditTimeline}>{t('canvas.miniTool.videoUI.editTimeline')}</Button>}</>;
    }
    case 'video.split': {
      // Demo main.tsx split branch: Detect, then the cut editor once the grid is usable (frames-split §10.6: until then
      // only the ledger line the container draws), then a failed detection's row with Retry.
      const failed = latestMiniToolAnalysis(props.analyses.filter((record) => record.kind === 'scene_cuts'))?.status === 'failed';
      return <><Button variant='outline' size='sm' data-testid='video-detect-scenes' loading={props.analysing} disabled={props.disabled || props.analysing} onClick={() => props.onAnalyse('scene_cuts')}>{t(props.analyses.some((record) => record.kind === 'scene_cuts') ? 'canvas.miniTool.videoUI.detectAgain' : 'canvas.miniTool.videoUI.detectScenes')}{props.analysisCreditText === undefined ? null : <span className='text-xs text-muted-foreground'>{props.analysisCreditText}</span>}</Button>
        {props.grid === null ? null : <VideoCutEditor {...props} grid={props.grid} />}
        {failed ? <div data-testid='video-detection-error' className='flex items-center justify-between gap-3 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.detectionError')}</span><Button variant='outline' size='compact' disabled={props.disabled || props.analysing} onClick={() => props.onAnalyse('scene_cuts')}>{t('canvas.task.action.retry')}</Button></div> : null}</>;
    }
  }
}

/**
 * The cuts as stored and shown (canvas design §4 split row): sorted, unique and inside the video, not snapped, so a typed
 * value stays what was typed; only the plan snaps them to frame starts. A cut at 0 or at or past the end is left out
 * rather than refused.
 * @param duration - The presentation's video end.
 * @param cuts - The stored or edited cuts.
 * @returns The normalized cuts.
 * @throws {never} Never.
 */
export function splitCuts(duration: number, cuts: readonly number[]): number[] {
  return [...new Set(cuts.filter((cut) => cut > 0 && cut < duration))].sort((a, b) => a - b);
}

/** One cut row, its id kept while the row lives so the row's input and handle keep their element. */
interface CutRow { id: string; value: number }

/**
 * Gives each value the id of the first unused earlier row with that value, and a new id otherwise, so a row keeps its
 * element when the rows are reordered or merged.
 * @param previous - The rows shown before.
 * @param values - The values to show.
 * @returns The rows.
 * @throws {never} Never.
 */
function withRowIds(previous: readonly CutRow[], values: readonly number[]): CutRow[] {
  const free = [...previous];
  return values.map((value) => {
    const at = free.findIndex((row) => row.value === value);
    return { id: at < 0 ? newId() : free.splice(at, 1)[0]!.id, value };
  });
}

/**
 * Edits split cuts on the source clock (demo video-controls.tsx CutEditor and PlaybackStrip cuts): numbered handles on the
 * filmstrip that drag (committed once on release), step one frame with the arrow keys and go with Delete; the count with
 * Add at cursor; one row per cut; and one button per segment that plays exactly that range in the node's player.
 * Cuts are stored as grid frame numbers (frames-split §10.7 split row); the editor shows them as the seconds their frames
 * start at, and a typed or dragged time becomes the frame covering it.
 * @param props - The panel props and the usable grid.
 * @returns The cut editor.
 * @throws {z.ZodError} When the grid is malformed.
 */
function VideoCutEditor(props: VideoToolControlsProps & { grid: VideoPlanGrid }): React.JSX.Element {
  const t = useTranslation();
  const { grid } = props;
  const draft = props.draft as VideoToolDraftById['video.split'];
  const duration = gridDuration(grid);
  const cutFrames = React.useMemo(() => splitCuts(grid.frameCount, draft.params.cuts), [grid.frameCount, draft.params.cuts]);
  const cuts = React.useMemo(() => cutFrames.map((frame) => gridSeconds(grid, frame)), [grid, cutFrames]);
  const segments = React.useMemo(() => planVideoSplit(grid, cutFrames), [grid, cutFrames]);
  // Each handle sits on the frame start its cut splits at.
  const snapped = cuts;
  /**
   * The grid frames a list of shown times stand for, each the frame covering it.
   * @param values - Times in seconds.
   * @returns Frame numbers.
   * @throws {never} Never.
   */
  const toFrames = (values: readonly number[]): number[] => values.map((value) => gridFrameCovering(grid, value));
  // The rows while one is typed (`id`): written back in place so the typed text stays on its row (web AGENTS "Inputs send
  // what they show"). Leaving the field writes nothing: every reader normalizes, so the rows then show the ordered cuts.
  const [typing, setTyping] = React.useState<{ rows: CutRow[]; id: string } | null>(null);
  // The rows last shown, or those an edit just wrote, whose ids the next rows take by value so an edited row (a stepped or
  // dragged handle) keeps its element and focus.
  const shown = React.useRef<CutRow[]>([]);
  const rows = React.useMemo(() => typing?.rows ?? withRowIds(shown.current, cuts), [typing, cuts]);
  React.useLayoutEffect(() => { shown.current = rows; }, [rows]);
  const handles = React.useMemo(() => withRowIds(rows, cuts), [rows, cuts]);
  // A bin press keeps the focus where it is (its mousedown is prevented), so leaving a typed row does not reorder the rows
  // under the pointer before the click removes one.
  const [dragging, setDragging] = React.useState<{ index: number; time: number; moved: boolean } | null>(null);
  const gesture = React.useRef<string | null>(null);
  React.useEffect(() => { gesture.current = null; setDragging(null); }, [draft.revision, props.sourceEpoch, props.seekEpoch, props.disabled]);
  const [previewing, setPreviewing] = React.useState<{ start: number; end: number } | null>(null);
  const [playFailed, setPlayFailed] = React.useState(false);
  const playback = React.useRef<SourceRangePlayback | null>(null);
  React.useEffect(() => () => playback.current?.stop(), []);
  /**
   * Commits edited rows, their cuts normalized, keeping each row's id for the rows that follow.
   * @param next - The edited rows.
   * @throws {never} Never.
   */
  const commit = (next: CutRow[]): void => {
    shown.current = next;
    props.onChange({ ...draft, params: { ...draft.params, cuts: splitCuts(grid.frameCount, toFrames(next.map((row) => row.value))) } });
  };
  /**
   * The handles with one cut moved.
   * @param index - The handle.
   * @param value - Its new cut.
   * @returns The rows.
   * @throws {never} Never.
   */
  const moveTo = (index: number, value: number): CutRow[] => handles.map((row, position) => position === index ? { id: row.id, value } : row);
  /**
   * The start of the frame under the pointer on the strip a handle sits on, the cut a drag there makes; a drag past either
   * end keeps one frame on that side, as the demo's drag stays inside the video.
   * @param event - The pointer event on a handle.
   * @returns The frame start in seconds.
   * @throws {never} Never.
   */
  const frameStartAt = (event: React.PointerEvent<HTMLElement>): number => {
    const box = event.currentTarget.parentElement?.getBoundingClientRect();
    const time = box === undefined || box.width <= 0 ? 0 : Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration;
    const last = grid.frameCount - 1;
    // A one-frame video has no frame a cut can start, and the release below commits nothing at 0.
    return last < 1 ? 0 : gridSeconds(grid, Math.max(1, Math.min(last, gridFrameCovering(grid, time))));
  };
  /**
   * Writes a typed row in place, unsorted and not merged, so the typed text stays on the row being typed.
   * @param id - The typed row.
   * @param value - The typed number.
   * @throws {never} Never.
   */
  const type = (id: string, value: number): void => {
    const next = rows.map((row) => row.id === id ? { id, value } : row);
    setTyping({ rows: next, id });
    props.onChange({ ...draft, params: { ...draft.params, cuts: toFrames(next.map((row) => row.value)) } });
  };
  /**
   * Ends typing once the field is left; the rows then show the ordered cuts.
   * @throws {never} Never.
   */
  const settle = (): void => { setTyping(null); };
  /**
   * Removes a row; the row being typed, when it is another one, stays typed with its focus.
   * @param id - The removed row.
   * @throws {never} Never.
   */
  const remove = (id: string): void => {
    const next = rows.filter((row) => row.id !== id);
    shown.current = next;
    setTyping(typing !== null && typing.id !== id ? { rows: next, id: typing.id } : null);
    props.onChange({ ...draft, params: { ...draft.params, cuts: toFrames(next.map((row) => row.value)) } });
  };
  /**
   * Moves a cut one frame back or forward from the frame it splits at, keeping it inside the video.
   * @param index - The cut.
   * @param backwards - Whether to step back.
   * @throws {never} Never.
   */
  const step = (index: number, backwards: boolean): void => {
    const neighbour = cutFrames[index]! + (backwards ? -1 : 1);
    if (neighbour >= 1 && neighbour < grid.frameCount) commit(moveTo(index, gridSeconds(grid, neighbour)));
  };
  /**
   * Plays one segment in the node's player and shows it until it ends; a refused play says the media is unavailable.
   * @param start - The segment start.
   * @param end - The segment end.
   * @throws {never} A refused play is shown.
   */
  const preview = (start: number, end: number): void => {
    playback.current?.stop();
    const next = props.onPlayRange?.(start, end);
    if (next === undefined) return;
    playback.current = next;
    setPreviewing({ start, end });
    setPlayFailed(false);
    next.done.then(() => { if (playback.current === next) { playback.current = null; setPreviewing(null); } },
      () => { if (playback.current === next) { playback.current = null; setPreviewing(null); setPlayFailed(true); } });
  };
  const { onChange } = props;
  const add = React.useCallback((time: number): void => {
    const next = [...handles, { id: newId(), value: time }];
    shown.current = next;
    onChange({ ...draft, params: { ...draft.params, cuts: splitCuts(grid.frameCount, next.map((row) => gridFrameCovering(grid, row.value))) } });
  }, [onChange, draft, grid, handles]);
  return <div className='grid gap-2' data-testid='video-cut-editor'>
    <VideoPlaybackStrip src={draft.source.canonicalURL} duration={duration} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} presentedTime={props.presentedTime} liveClock={props.liveClock} onSeek={props.onSeek}>
      {handles.map(({ id }, index) => <Button key={id} variant={null} size={null} data-testid={`video-cut-handle-${index}`} disabled={props.disabled} className='absolute inset-y-0 z-10 w-6 -translate-x-1/2 rounded-none' style={{ left: `${(dragging?.index === index ? dragging.time : snapped[index]!) * 100 / duration}%` }}
        onPointerDown={(event) => {
          if (event.button !== 0 || props.disabled) return;
          // Prevented so the press neither seeks the strip nor selects; focused by hand, so the keys then act on this handle.
          event.stopPropagation(); event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = draft.revision;
          setDragging({ index, time: snapped[index]!, moved: false });
        }}
        onPointerMove={(event) => { if (dragging?.index !== index) return; event.stopPropagation(); setDragging({ index, time: frameStartAt(event), moved: true }); }}
        onPointerUp={(event) => {
          if (dragging?.index !== index) return;
          event.stopPropagation();
          // A press without a move only focuses the handle for the arrow keys; a drag commits where it was last drawn.
          const { time, moved } = dragging;
          const current = gesture.current === draft.revision && !props.disabled;
          gesture.current = null; setDragging(null);
          if (moved && current && time > 0 && time < duration) commit(moveTo(index, time));
        }}
        onPointerCancel={() => { gesture.current = null; setDragging(null); }}
        onKeyDown={(event) => {
          if (props.disabled) return;
          if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); commit(handles.filter((_, position) => position !== index)); }
          else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); step(index, event.key === 'ArrowLeft' || event.key === 'ArrowDown'); }
        }}><span className='h-full border-l border-status-selected' /><span className='absolute bottom-0 rounded-chrome-sm bg-popover px-1 text-xs text-foreground'>{index + 1}</span></Button>)}
    </VideoPlaybackStrip>
    <div className='flex items-center justify-between gap-2'><span data-testid='video-cut-count' className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.cutSummary', { cuts: segments.length - 1, segments: segments.length })}</span><AddCutButton grid={grid} starts={snapped} presentedTime={props.presentedTime} liveClock={props.liveClock} disabled={props.disabled} onAdd={add} /></div>
    {rows.length === 0 ? <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.noCuts')}</p> : <ScrollArea className='max-h-48' viewportClassName='max-h-48'><div className='grid gap-2'>{rows.map(({ id, value: cut }, index) => <div key={id} className='flex items-center gap-2'><span className='text-xs'>{index + 1}</span><VideoNumericInput value={cut} label={`${t('canvas.miniTool.videoUI.cutPoint')} ${index + 1}`} testId={`video-cut-${index}`} min={0} exclusiveMin max={duration} exclusiveMax disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(value) => type(id, value)} onSettle={settle} /><span className='text-xs'>s</span><Button variant='ghost' size='compact' disabled={props.disabled} aria-label={t('canvas.miniTool.videoUI.removeCut')} onMouseDown={(event) => event.preventDefault()} onClick={() => remove(id)}><Trash2 className='size-3.5' /></Button></div>)}</div></ScrollArea>}
    <div className='flex min-h-8 overflow-hidden rounded-chrome border border-border'>{segments.map((segment) => <Button key={segment.outputIndex} variant={null} size={null} data-testid={`video-segment-${segment.outputIndex}`} disabled={props.onPlayRange === undefined} className='min-w-0 rounded-none border-r border-border bg-accent px-1 py-2 text-xs last:border-r-0 hover-enabled:bg-accent-strong' style={{ flexGrow: segment.end - segment.start, flexBasis: 0 }} onClick={() => preview(gridSeconds(grid, segment.start), gridSeconds(grid, segment.end))}>{segment.outputIndex + 1}</Button>)}</div>
    {previewing === null ? null : <div data-testid='video-segment-preview' className='flex items-center justify-between gap-2 text-xs text-muted-foreground'><span className='tabular-nums'>{t('canvas.miniTool.videoUI.segmentPreview', { start: secondsLabel(previewing.start), end: secondsLabel(previewing.end) })}</span><Button variant='outline' size='compact' onClick={() => playback.current?.stop()}>{t('canvas.miniTool.videoUI.stopPreview')}</Button></div>}
    {playFailed ? <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.mediaError')}</p> : null}
  </div>;
}

interface AddCutButtonProps { grid: VideoPlanGrid; starts: readonly number[]; presentedTime: number | null; liveClock?: VideoPlaybackLiveClock; disabled: boolean; onAdd: (time: number) => void }

/**
 * Add at cursor, available by the time the strip's head shows; a press reads the live clock, so a cut added while the
 * source plays lands where the head is, not at the time the panel last rendered with. A time makes a new cut when the
 * frame start it splits at, by planVideoSplit's snap rule, is after the first frame and not already a cut's; this is
 * read on every animation frame while the source plays, so it is not a whole plan.
 * @param props - The grid, the frame starts the cuts split at, the clock and the add command.
 * @returns The button.
 * @throws {never} Never.
 */
const AddCutButton = React.memo(function AddCutButton(props: AddCutButtonProps): React.JSX.Element {
  const t = useTranslation();
  const { grid, starts } = props;
  const duration = gridDuration(grid);
  /**
   * Whether a cut at this time would make a new segment.
   * @param time - The time, null while no frame is shown.
   * @returns True when it splits a segment.
   * @throws {never} Never.
   */
  const makesCut = (time: number | null): time is number => {
    if (time === null || !(time > 0 && time < duration)) return false;
    // The clock is the presented frame's mediaTime, whose grid frame is round(mediaTime × fps) (frames-split §4.3).
    const frame = frameIndexOfMediaTime(time, grid);
    return frame > 0 && !starts.includes(gridSeconds(grid, frame));
  };
  const shown = useShownTime(props.liveClock, props.presentedTime);
  return <Button variant='outline' size='compact' data-testid='video-add-cut' disabled={props.disabled || !makesCut(shown)} onClick={() => { const time = props.liveClock?.read() ?? props.presentedTime; if (makesCut(time)) props.onAdd(gridSeconds(grid, frameIndexOfMediaTime(time, grid))); }} icon={<Plus className='size-3' />}>{t('canvas.miniTool.videoUI.atCursor')}</Button>;
});

interface FrameCardsProps { source: VideoPresentationSource | null; grid: VideoPlanGrid; frames: readonly number[]; aspect: number; onSeek?: (time: number) => void }

/**
 * Decodes the selected frame into one preview filling the row (canvas design §4 frames row).
 * @param props - The selected source frame and canonical source.
 * @returns Real images, their exact source timestamps, and visible read failures.
 * @throws {never} Decode failures remain visible with a retry action.
 */
function VideoFrameCardRow(props: FrameCardsProps): React.JSX.Element {
  const [retry, setRetry] = React.useState(0);
  const decoded = useVideoFrameThumbnails(props.source, props.frames, retry);
  const t = useTranslation();
  return <div className='grid gap-2'><div className='flex justify-center gap-2'>{props.frames.map((frameIndex) => {
    const image = decoded.frames.find((item) => item.frameIndex === frameIndex);
    const start = gridSeconds(props.grid, frameIndex);
    // A jump to a frame seeks its midpoint (frames-split §4.3).
    return <Button key={frameIndex} variant={null} size={null} className='grid w-full min-w-0 items-stretch justify-stretch overflow-hidden rounded-chrome border border-border text-left' onClick={() => props.onSeek?.(frameMidpointSeconds(frameIndex, props.grid.fps))}><span className='relative block w-full bg-muted' style={{ aspectRatio: props.aspect }}>{image === undefined ? <Skeleton className='absolute inset-0 size-full' /> : <img src={image.url} alt='' data-frame-time={start} className='absolute inset-0 size-full object-contain object-center' />}</span><span className='px-2 py-1 text-xs tabular-nums'>{start.toFixed(3)} s</span></Button>;
  })}</div>{decoded.status === 'failed' ? <div className='flex items-center justify-center gap-2 text-xs text-status-error-foreground'><span>{t('canvas.miniTool.videoUI.mediaError')}</span><Button variant='outline' size='compact' onClick={() => setRetry((value) => value + 1)}>{t('canvas.miniTool.videoUI.retryPreview')}</Button></div> : null}</div>;
}

/**
 * The one preview of the selected frame, below the mode row.
 * @param props - The selected frame and its source geometry.
 * @returns The preview root.
 * @throws {never} Never.
 */
function VideoFramePreview(props: FrameCardsProps): React.JSX.Element {
  return <div data-testid='video-frame-previews'><VideoFrameCardRow {...props} /></div>;
}
