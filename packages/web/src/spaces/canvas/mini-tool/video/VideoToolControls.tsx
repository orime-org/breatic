// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useVideoFrameThumbnails } from '@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails';
import type { VideoPresentationSource } from '@web/spaces/canvas/video-presentation/types';
import { Skeleton } from '@web/components/ui/skeleton';
import { AudioLines, Film, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { newId, type ModelEntry } from '@breatic/shared';
import { lipsyncFailureRetryable, planVideoFrames, trackedMaskRetryable, planVideoSplit, type LipsyncFailureReason, presentationFrameAt, presentationFrameCount, presentationVideoEnd, type MiniToolAnalysisRecord, type VideoPresentationTable, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { Input } from '@web/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { FilmStrip } from '@web/spaces/canvas/mini-tool/FilmStrip';
import { Textarea } from '@web/components/ui/textarea';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { useRunning } from '@web/stores/task-actions-in-flight';
import { SlotTool } from '@web/spaces/canvas/generate/generate-tools';
import { PARAM_OPTION_CLASS, ParamOptionGroup } from '@web/spaces/canvas/generate/ParamOptionGroup';
import { EXPAND_RATIOS, frameForRatio } from '@web/spaces/canvas/mini-tool/expand-frame';
import { editDialogue } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import { useFollowCanvasViewport } from '@web/spaces/canvas/generate/use-follow-canvas-viewport';
import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';

/** A duration range a lip-sync model accepts, both ends included (config `executions.video.lip-sync`). */
export interface LipSyncDurationRange { minDurationSeconds: number; maxDurationSeconds: number }
/** The configured lip-sync models in order, the first the default, and the tracking model's range. */
export interface LipSyncChoices { models: (ModelEntry & LipSyncDurationRange)[]; tracking: LipSyncDurationRange; maxPeople?: number; maxDialogues?: number }

export interface VideoToolControlsProps<K extends VideoToolId = VideoToolId> {
  toolId: K;
  draft: VideoToolDraftById[K];
  onChange: (draft: VideoToolDraftById[K]) => void;
  analyses: readonly MiniToolAnalysisRecord[];
  previewSource?: VideoPresentationSource | null;
  frameTable: VideoPresentationTable | null;
  presentedTime: number | null;
  disabled: boolean;
  pickingSlot: string | null;
  inputNames: ReadonlyMap<string, string>;
  onPick: (key: string) => void;
  onAnalyse: (kind: 'people' | 'scene_cuts' | 'tracked_mask') => void;
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
  /** The source's display size an expansion's ratio frames wrap (the presentation's, sample aspect ratio applied). */
  expandSize?: { width: number; height: number };
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
  React.useEffect(() => {
    if (persisted !== written.current) {
      written.current = persisted;
      setText(String(persisted));
      onInvalidChange?.(testId, false);
    }
  }, [persisted, testId, onInvalidChange]);
  React.useEffect(() => () => onInvalidChange?.(testId, false), [onInvalidChange, testId]);
  const numeric = text.trim() === '' ? NaN : Number(text);
  const invalid = !Number.isFinite(numeric) || numeric < props.min || (props.exclusiveMin === true && numeric === props.min) || (props.max !== undefined && (numeric > props.max || props.exclusiveMax === true && numeric === props.max));
  return <Input type='text' inputMode='decimal' autoComplete='off' value={text} aria-label={props.label} data-testid={props.testId} aria-invalid={invalid} disabled={props.disabled} className='h-[var(--control-height)] min-w-0 px-2 text-xs tabular-nums md:text-xs' onChange={(event) => {
    const nextText = event.currentTarget.value;
    setText(nextText);
    const value = nextText.trim() === '' ? NaN : Number(nextText);
    const bad = !Number.isFinite(value) || value < props.min || (props.exclusiveMin === true && value === props.min) || (props.max !== undefined && (value > props.max || props.exclusiveMax === true && value === props.max));
    props.onInvalidChange?.(props.testId, bad);
    if (!bad) {
      written.current = value;
      props.onChange(value);
    }
  }} />;
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
  const successful = latestMiniToolAnalysis(props.analyses.filter((item) => item.kind === 'people' && item.status === 'completed' && !item.artifactUnavailable));
  const result = successful?.result?.kind === 'people' ? successful.result : undefined;
  const people = result?.people ?? [];
  const ready = successful !== null;
  const rows = draft.params.dialogues;
  const maxPeople = props.lipSync?.maxPeople;
  const maxDialogues = props.lipSync?.maxDialogues;
  const rowsFull = maxDialogues !== undefined && rows.length >= maxDialogues;
  /**
   * Whether binding a person to a row would take the run past its people cap (canvas design §4 lip-sync row).
   * @param dialogueId - The row.
   * @param personId - The person.
   * @returns True when it would.
   * @throws {never} Never.
   */
  const overPeople = (dialogueId: string, personId: string): boolean => maxPeople !== undefined
    && new Set([...rows.filter((row) => row.dialogueId !== dialogueId && row.personId !== null).map((row) => row.personId), personId]).size > maxPeople;
  /**
   * Commits all rows atomically without collapsing repeated people.
   * @throws {never} Never.
   * @param next - The complete next snapshot or sequence.
   */
  function changeRows(next: typeof rows): void {
    const referenced = new Set(next.map((row) => row.audioInputId));
    props.onChange({ ...draft, inputs: draft.inputs.filter((input) => referenced.has(input.inputId)), params: { ...draft.params, dialogues: next } });
  }
  return <section className='grid min-w-0 gap-2.5' data-testid='video-lip-sync-controls'>
    <div className='flex items-center justify-between gap-3'>
      <span className='text-xs font-medium'>{t('canvas.miniTool.videoUI.dialoguePairs')}</span>
      <Button variant='outline' size='compact' data-testid='video-identify-people' loading={props.analysing} disabled={props.disabled || props.analysing} icon={<RefreshCw className='size-3' />} onClick={() => props.onAnalyse('people')}>{t('canvas.miniTool.videoUI.redetectPeople')}{props.analysisCreditText === undefined ? null : <span className='text-xs text-muted-foreground'>{props.analysisCreditText}</span>}</Button>
    </div>
    {ready && people.length > 0 && !props.analysing && record?.status !== 'failed' ? null : <p className={`rounded-chrome border p-2.5 text-xs ${record?.status === 'failed' ? 'border-status-error text-status-error-foreground' : 'border-border text-muted-foreground'}`}>{props.analysing ? t('canvas.miniTool.videoUI.identifyingPeople') : record?.status === 'failed' ? t('canvas.miniTool.videoUI.peopleIdentificationFailed') : ready ? t('canvas.miniTool.videoUI.peopleEmpty') : t('canvas.miniTool.videoUI.peopleIdle')}</p>}
    <div className='grid grid-cols-[max-content_minmax(0,1fr)_8ch_24px] items-center gap-x-2 gap-y-1.5'>
      <span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.targetPerson')}</span><span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.dialogueAudio')}</span><span className='whitespace-nowrap text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.dialogueStartTime')}</span><span />
      {rows.map((row, index) => {
        const input = draft.inputs.find((item) => item.inputId === row.audioInputId);
        const selected = row.analysisRunId === result?.analysisRunId ? people.find((person) => person.personId === row.personId) : undefined;
        const thumbnail = selected?.artifactRefs.find((artifact) => artifact.role === 'thumbnail')?.canonicalURL;
        const slotKey = `dialogue:${row.dialogueId}`;
        return <div key={row.dialogueId} className='col-span-4 grid grid-cols-subgrid items-center gap-x-2 gap-y-1.5' data-testid={`video-dialogue-${row.dialogueId}`} onFocusCapture={() => props.onActiveDialogue?.(row.dialogueId)}>
          <Select onOpenChange={setOpen} value={selected?.personId ?? ''} disabled={props.disabled || props.analysing || !ready || people.length === 0} onValueChange={(personId) => {
            if (overPeople(row.dialogueId, personId)) { toast.warning(t('server.mini_tool.lipSyncTooManyPeople', { max: maxPeople ?? 0 })); return; }
            changeRows(editDialogue(rows, row.dialogueId, { personId, analysisRunId: result?.analysisRunId ?? null }));
          }}>
            <SelectTrigger data-testid={`video-person-${row.dialogueId}`} className='w-auto gap-1.5 px-2 text-xs'><span className='relative size-5 shrink-0 overflow-hidden rounded-content-xs bg-muted'>{thumbnail === undefined ? <Users className='size-5 text-muted-foreground' /> : <img src={thumbnail} alt='' className='size-full object-cover' />}</span><span className='min-w-0 truncate'><SelectValue placeholder={t('canvas.miniTool.videoUI.choosePerson')} /></span></SelectTrigger>
            <SelectContent avoidCollisions={false}>{people.map((person, personIndex) => <SelectItem key={person.personId} value={person.personId} aria-disabled={overPeople(row.dialogueId, person.personId) ? true : undefined} className='aria-disabled:opacity-50'>{t('canvas.miniTool.videoUI.personNumber', { number: personIndex + 1 })}</SelectItem>)}</SelectContent>
          </Select>
          <div className={'min-w-0 [&>div]:min-w-0 [&>div>button:first-child]:h-[var(--control-height)] [&>div>button:first-child]:w-full [&>div>button:first-child]:min-w-0 [&>div>button:first-child]:flex-row [&>div>button:first-child]:justify-start [&>div>button:first-child]:gap-1.5 [&>div>button:first-child]:pr-6 [&>div>button:first-child>span]:truncate [&>div>button[aria-pressed=false]]:border-border [&>div>button[aria-pressed=true]]:border-active-border [&>div>button[aria-pressed=true]]:bg-accent [&>div>button[aria-pressed=true]]:text-foreground' + (input === undefined ? '' : ' [&>div>button:first-child>svg]:hidden [&>div>button:first-child]:pl-2')}>
            <SlotTool testId={`video-audio-${row.dialogueId}`} thumbnailTestId={`video-audio-thumbnail-${row.dialogueId}`} clearTestId={`video-audio-clear-${row.dialogueId}`} Icon={AudioLines} onPick={() => props.onPick(slotKey)} active={props.pickingSlot === slotKey} pick={input === undefined ? undefined : { kind: 'audio', url: input.url }} disabled={props.disabled} onClear={() => { if (props.pickingSlot === slotKey) props.onEndPick?.(); changeRows(editDialogue(rows, row.dialogueId, { audioInputId: null })); }} clearLabel={t('canvas.miniTool.panel.clearSlot')} label={input === undefined ? t('canvas.miniTool.videoUI.chooseDialogueAudio') : props.inputNames.get(input.inputId) ?? input.url.split('/').at(-1) ?? ''} tip={t('canvas.miniTool.videoUI.pickAudio')} />
          </div>
          <div className='flex min-w-0 items-center gap-1'><VideoNumericInput value={row.startTime} label={`${t('canvas.miniTool.videoUI.dialogueStartTime')} ${index + 1}`} testId={`video-start-${row.dialogueId}`} min={0} disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(startTime) => changeRows(editDialogue(rows, row.dialogueId, { startTime }))} /><span className='text-xs text-muted-foreground'>s</span></div>
          <Button variant='ghost' size='compact' className='size-6 px-0' disabled={props.disabled} aria-label={t('canvas.miniTool.videoUI.removeDialogue')} onClick={() => { if (props.pickingSlot === slotKey) props.onEndPick?.(); changeRows(rows.length > 1 ? rows.filter((item) => item.dialogueId !== row.dialogueId) : [{ dialogueId: newId(), personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }]); }}><Trash2 className='size-3.5' /></Button>
        </div>;
      })}
    </div>
    <Button variant='outline' size='compact' className='w-fit aria-disabled:opacity-50' disabled={props.disabled || props.analysing || !ready || people.length === 0} aria-disabled={rowsFull ? true : undefined} onClick={() => {
      if (rowsFull) { toast.warning(t('server.mini_tool.lipSyncTooManyDialogues', { max: maxDialogues })); return; }
      changeRows([...rows, { dialogueId: newId(), personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }]);
    }} icon={<Plus className='size-3.5' />}>{t('canvas.miniTool.videoUI.addDialogue')}</Button>
    {props.lipSync === undefined || props.lipSync.models.length === 0 ? null : <div className='flex items-center gap-1.5'><ModelPicker models={props.lipSync.models} value={draft.params.modelId ?? props.lipSync.models[0].name} onChange={(modelId) => props.onChange({ ...draft, params: { ...draft.params, modelId } })} /></div>}
    <ParamOptionGroup label={t('canvas.miniTool.videoUI.syncMode')} options={[{ value: 'cut_off', label: 'Cut off' }, { value: 'silence', label: 'Silence' }, { value: 'loop', label: 'Loop' }, { value: 'bounce', label: 'Bounce' }, { value: 'remap', label: 'Remap' }].map((option) => ({ ...option, disabled: props.disabled }))} value={draft.params.syncMode} testIdPrefix='video-sync' onSelect={(syncMode) => props.onChange({ ...draft, params: { ...draft.params, syncMode: syncMode as typeof draft.params.syncMode } })} />
    {props.lipSyncFailure ? <LipSyncFailure reason={props.lipSyncFailure} disabled={props.disabled} onRetry={props.onRetryFailed} retryIntent={props.retryIntent} onRedetect={() => props.onAnalyse('people')} /> : null}
  </section>;
}

const PERSON_CATEGORY_KEYS = { no_face: 'personFailNoFace', model_rejected: 'personFailRejected', timeout: 'personFailTimeout', failed: 'personFailFailed', stopped: 'personFailStopped' } as const;
const PERSON_NEXT_KEYS = { no_face: 'personFailNoFaceNext', model_rejected: 'personFailRejectedNext', timeout: 'personFailRetryNext', failed: 'personFailRetryNext', stopped: 'personFailStoppedNext' } as const;
const SHARED_STEP_KEYS = { prepare: 'sharedFailPreparation', composite: 'sharedFailCompositing', stitch: 'sharedFailStitching', expired: 'sharedFailExpired' } as const;

/**
 * A failed lip-sync run (canvas design §4 lip-sync row, execution design §9.4): one line per person that did not succeed, by
 * detection number, with its category and next step, and one line for a failed shared step; once a person has no face or
 * was rejected, the other people follow that person. Retry is offered only when the shared rule says every failure can
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
  return <div className='grid gap-2 rounded-chrome border border-status-error-border bg-status-error-bg p-2 text-xs text-status-error-foreground' data-testid='video-lip-sync-failure'>
    <ul className='grid min-w-0 gap-1.5'>
      {persons.map((person) => {
        const follows = blocker !== undefined && person.category !== 'no_face' && person.category !== 'model_rejected';
        const next = follows ? t(`canvas.miniTool.videoUI.${person.category === 'stopped' ? 'personFailStoppedNext' : 'personFailFollowNext'}`, { number: blocker }) : t(`canvas.miniTool.videoUI.${PERSON_NEXT_KEYS[person.category]}`);
        return <li key={person.personId} className='grid gap-0.5'><span className='font-medium'>{`${t('canvas.miniTool.videoUI.personNumber', { number: person.detectionNumber })} · ${t(`canvas.miniTool.videoUI.${PERSON_CATEGORY_KEYS[person.category]}`)}`}</span><span>{next}</span></li>;
      })}
      {shared === null ? null : <li className='grid gap-0.5'><span className='font-medium'>{t(`canvas.miniTool.videoUI.${SHARED_STEP_KEYS[shared.step]}`)}</span><span>{t(`canvas.miniTool.videoUI.${PERSON_NEXT_KEYS[shared.category]}`)}</span></li>}
    </ul>
    {retryable || (noFace && props.onRedetect !== undefined) ? <div className='flex justify-end'>{retryable
      ? <Button variant='outline' size='compact' loading={retrying} disabled={props.disabled} onClick={props.onRetry}>{t('canvas.miniTool.videoUI.retryFailedPeople')}</Button>
      : <Button variant='outline' size='compact' disabled={props.disabled} onClick={props.onRedetect}>{t('canvas.miniTool.videoUI.redetectPeople')}</Button>}</div> : null}
  </div>;
}

/**
 * Renders the approved parameter controls for the selected video tool.
 * @throws {Error} When a supplied frame table or draft is malformed.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoToolControls(props: VideoToolControlsProps): React.JSX.Element {
  const t = useTranslation();
  const previewFrames = React.useMemo(() => {
    if (props.toolId !== 'video.extract-frames' || props.frameTable === null) return [];
    const draft = props.draft as VideoToolDraftById['video.extract-frames'];
    if (draft.params.mode === 'current' && props.presentedTime === null) return [];
    const request = draft.params.mode === 'current' && props.presentedTime !== null ? { ...draft.params, currentTime: props.presentedTime } : draft.params;
    return planVideoFrames(props.frameTable, request).map((frame) => presentationFrameAt(props.frameTable!, frame.frameIndex));
  }, [props.toolId, props.frameTable, props.draft, props.presentedTime]);
  switch (props.toolId) {
    case 'video.expand': {
      const draft = props.draft as VideoToolDraftById['video.expand'];
      return <><div className='grid grid-cols-4 gap-1.5' data-testid='video-expand-ratios'>{EXPAND_RATIOS.map((ratio) => <Button key={ratio} variant={null} size={null} disabled={props.disabled} aria-current={draft.params.ratio === ratio} className={PARAM_OPTION_CLASS} onClick={() => props.onChange({ ...draft, params: { ...draft.params, ratio, frame: frameForRatio(ratio, props.expandSize ?? draft.source.mediaInfo, draft.params.frame) } })}>{ratio === 'free' ? 'Free' : ratio}</Button>)}</div><Textarea autoComplete='off' value={draft.params.prompt} disabled={props.disabled} placeholder={t('canvas.miniTool.videoUI.expandPrompt')} onChange={(event) => props.onChange({ ...draft, params: { ...draft.params, prompt: event.currentTarget.value } })} /></>;
    }
    case 'video.lip-sync': return <PeopleDialogues {...props} />;
    case 'video.erase': {
      const draft = props.draft as VideoToolDraftById['video.erase'];
      // The last tracking's failure, named by its stored code (execution design §10.3 code table).
      const tracking = latestMiniToolAnalysis(props.analyses.filter((record) => record.kind === 'tracked_mask'));
      const code = tracking?.status === 'failed' ? tracking.error?.code : undefined;
      const trackingFailure = typeof code === 'string' ? TRACKING_FAILURES.find((known) => known === code) ?? 'failed' : null;
      return <><ParamOptionGroup label={t('canvas.miniTool.videoUI.selection')} value={props.regionSelection ?? 'rectangle'} options={[{ value: 'rectangle', label: t('canvas.miniTool.videoUI.rectangle'), disabled: props.disabled }, { value: 'point', label: t('canvas.miniTool.videoUI.point'), disabled: props.disabled }]} testIdPrefix='video-region-selection' onSelect={(value) => props.onRegionSelection?.(value as 'rectangle' | 'point')} /><p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.drawBox')}</p><div className='relative h-12 overflow-hidden rounded-chrome border border-border'><FilmStrip src={draft.source.canonicalURL} duration={draft.source.mediaInfo.duration} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} /></div><div className='grid grid-cols-2 gap-2'><label className='grid gap-1 text-xs'>{t('canvas.miniTool.videoUI.rangeStart')}<VideoNumericInput value={draft.params.range.start} label={t('canvas.miniTool.videoUI.rangeStart')} testId='video-range-start' exclusiveMax min={0} max={draft.params.range.end} disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(start) => { if (start < draft.params.range.end) props.onChange({ ...draft, params: { ...draft.params, range: { ...draft.params.range, start } } }); }} /></label><label className='grid gap-1 text-xs'>{t('canvas.miniTool.videoUI.rangeEnd')}<VideoNumericInput value={draft.params.range.end} label={t('canvas.miniTool.videoUI.rangeEnd')} testId='video-range-end' exclusiveMin min={draft.params.range.start} max={draft.source.mediaInfo.duration} disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(end) => { if (end > draft.params.range.start) props.onChange({ ...draft, params: { ...draft.params, range: { ...draft.params.range, end } } }); }} /></label></div><Textarea autoComplete='off' value={draft.params.trackingPrompt} disabled={props.disabled} placeholder={t('canvas.miniTool.videoUI.trackingPrompt')} onChange={(event) => props.onChange({ ...draft, params: { ...draft.params, trackingPrompt: event.currentTarget.value } })} /><div className='flex items-center gap-2'><Button variant='outline' size='sm' loading={props.analysing} aria-disabled={props.trackBlockedReason === undefined ? undefined : true} disabled={props.disabled || props.analysing || (draft.params.region.box === null && draft.params.region.points.length === 0)} className='aria-disabled:opacity-50' onClick={() => { if (props.trackBlockedReason !== undefined) toast.warning(props.trackBlockedReason); else props.onAnalyse('tracked_mask'); }}>{t('canvas.miniTool.videoUI.trackObject')}</Button>{props.analysisActualCreditText !== undefined ? <span className='text-xs tabular-nums text-muted-foreground'>{t('canvas.miniTool.videoUI.trackingActual', { credits: props.analysisActualCreditText })}</span> : props.analysisCreditText === undefined ? null : <span className='text-xs tabular-nums text-muted-foreground'>{t('canvas.miniTool.videoUI.trackingEstimate', { credits: props.analysisCreditText })}</span>}</div>{trackingFailure === null ? null : <div className='flex items-center justify-between gap-2 text-xs text-status-error-foreground'><span>{t(`canvas.miniTool.videoUI.trackingFailure.${trackingFailure}`)}</span>{trackedMaskRetryable(trackingFailure) ? <Button variant='outline' size='compact' loading={props.analysing} disabled={props.disabled || props.analysing} onClick={() => props.onAnalyse('tracked_mask')}>{t('canvas.miniTool.videoUI.retryTracking')}</Button> : null}</div>}</>;
    }
    case 'video.remove-bg': return <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.transparentOutput')}</p>;
    case 'video.extract-frames': {
      const draft = props.draft as VideoToolDraftById['video.extract-frames'];
      const planned = previewFrames;
      return <><ParamOptionGroup label={t('canvas.miniTool.videoUI.frameMode')} value={draft.params.mode} options={[{ value: 'first', label: t('canvas.miniTool.videoUI.first') }, { value: 'last', label: t('canvas.miniTool.videoUI.last') }, { value: 'current', label: t('canvas.miniTool.videoUI.current') }].map((option) => ({ ...option, disabled: props.disabled || option.value === 'current' && props.presentedTime === null }))} testIdPrefix='video-frame-mode' onSelect={(mode) => { if (mode === 'current' && props.presentedTime === null) return; props.onChange({ ...draft, params: { ...draft.params, mode: mode as typeof draft.params.mode, ...(mode === 'current' && props.presentedTime !== null ? { currentTime: props.presentedTime } : {}) } }); }} /><p className='text-center text-xs tabular-nums text-muted-foreground'>{props.frameTable === null ? t('canvas.miniTool.videoUI.loadingFrames') : draft.params.mode === 'current' && props.presentedTime === null ? t('canvas.miniTool.videoUI.currentFrameUnavailable') : t('canvas.miniTool.videoUI.frameCount', { count: planned.length })}</p><VideoFramePreview source={props.previewSource ?? null} frames={planned} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} onSeek={props.onSeek} /></>;
    }
    case 'video.transitions': {
      const draft = props.draft as VideoToolDraftById['video.transitions'];
      return <><span className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.videoInputs')}</span><div className='flex flex-wrap gap-2'>{draft.inputs.map((input) => <SlotTool key={input.inputId} testId={`video-timeline-input-${input.inputId}`} thumbnailTestId={`video-timeline-thumbnail-${input.inputId}`} clearTestId={`video-timeline-clear-${input.inputId}`} Icon={Film} onPick={() => props.onPick('timeline')} active={props.pickingSlot === 'timeline'} pick={{ kind: 'video', url: input.url, thumbnail: input.cover }} disabled={props.disabled} onClear={() => { if (props.pickingSlot === 'timeline') props.onEndPick?.(); props.onChange({ ...draft, inputs: draft.inputs.filter((item) => item.inputId !== input.inputId), params: { clips: draft.params.clips.filter((clip) => clip.inputId !== input.inputId) } }); }} clearLabel={t('canvas.miniTool.panel.clearSlot')} label={props.inputNames.get(input.inputId) ?? t('canvas.miniTool.videoUI.video')} tip={t('canvas.miniTool.videoUI.pickVideo')} />)}<SlotTool testId='video-timeline-add' thumbnailTestId='video-timeline-empty-thumbnail' clearTestId='video-timeline-empty-clear' Icon={Plus} onPick={() => props.onPick('timeline')} active={props.pickingSlot === 'timeline'} disabled={props.disabled} onClear={() => undefined} clearLabel={t('canvas.miniTool.panel.clearSlot')} label={t('canvas.miniTool.videoUI.addVideoSlot')} tip={t('canvas.miniTool.videoUI.pickVideo')} /></div><Button variant='outline' size='sm' onClick={props.onEditTimeline}>{t('canvas.miniTool.videoUI.editTimeline')}</Button></>;
    }
    case 'video.split': {
      const draft = props.draft as VideoToolDraftById['video.split'];
      const planned = props.frameTable === null ? [] : planVideoSplit(props.frameTable, draft.params.cuts);
      return <><VideoCutStrip {...props} /><Button variant='outline' size='sm' data-testid='video-detect-scenes' loading={props.analysing} disabled={props.disabled || props.analysing} onClick={() => props.onAnalyse('scene_cuts')}>{t('canvas.miniTool.videoUI.detectScenes')}{props.analysisCreditText === undefined ? null : <span className='text-xs text-muted-foreground'>{props.analysisCreditText}</span>}</Button><div className='flex items-center justify-between gap-2'><span className='text-xs text-muted-foreground'>{props.frameTable === null ? t('canvas.miniTool.videoUI.loadingFrames') : t('canvas.miniTool.videoUI.segmentCount', { count: planned.length })}</span><Button variant='outline' size='compact' disabled={props.disabled || props.frameTable === null || props.presentedTime === null || props.presentedTime <= 0 || props.presentedTime >= (props.frameTable === null ? 0 : presentationVideoEnd(props.frameTable))} onClick={() => { if (props.presentedTime !== null) props.onChange({ ...draft, params: { ...draft.params, cuts: [...new Set([...draft.params.cuts, props.presentedTime])].sort((a, b) => a - b) } }); }} icon={<Plus className='size-3' />}>{t('canvas.miniTool.videoUI.atCursor')}</Button></div><ScrollArea className='max-h-48' viewportClassName='max-h-48'><div className='grid gap-2'>{draft.params.cuts.map((cut, index) => <div key={index} className='flex items-center gap-2'><span className='text-xs'>{index + 1}</span><VideoNumericInput value={cut} label={`${t('canvas.miniTool.videoUI.cutPoint')} ${index + 1}`} testId={`video-cut-${index}`} min={0} max={props.frameTable === null ? draft.source.mediaInfo.duration : presentationVideoEnd(props.frameTable)} exclusiveMax disabled={props.disabled} onInvalidChange={props.onInvalidChange} onChange={(value) => props.onChange({ ...draft, params: { ...draft.params, cuts: draft.params.cuts.map((item, at) => at === index ? value : item) } })} /><span className='text-xs'>s</span><Button variant='ghost' size='compact' disabled={props.disabled} aria-label={t('canvas.miniTool.videoUI.removeCut')} onClick={() => props.onChange({ ...draft, params: { ...draft.params, cuts: draft.params.cuts.filter((_, at) => at !== index) } })}><Trash2 className='size-3.5' /></Button></div>)}</div></ScrollArea></>;
    }
  }
}

/**
 * Edits cut positions on the shared source clock with one atomic gesture commit.
 * @param props - The authoritative frame set, current draft and seek command.
 * @returns The source filmstrip and exact cut handles.
 * @throws {Error} When the supplied frame table is malformed.
 */
function VideoCutStrip(props: VideoToolControlsProps): React.JSX.Element {
  const draft = props.draft as VideoToolDraftById['video.split'];
  const [temporary, setTemporary] = React.useState<number[] | null>(null);
  const gesture = React.useRef<string | null>(null);
  const latest = React.useRef(props);
  latest.current = props;
  React.useEffect(() => { gesture.current = null; setTemporary(null); }, [draft.revision, props.sourceEpoch, props.seekEpoch, props.disabled]);
  const normalized = props.frameTable === null ? draft.params.cuts : planVideoSplit(props.frameTable, draft.params.cuts).slice(1).map((segment) => segment.start);
  const cuts = temporary ?? normalized;
  const duration = props.frameTable === null ? draft.source.mediaInfo.duration : presentationVideoEnd(props.frameTable);
  return <div className='grid gap-2'>
    <div className='relative h-14 overflow-hidden rounded-chrome border border-border'>
      <FilmStrip src={draft.source.canonicalURL} duration={duration} aspect={draft.source.mediaInfo.width / draft.source.mediaInfo.height} />
      {props.presentedTime === null ? null : <div className='absolute bottom-0 top-0 border-l border-status-selected' style={{ left: `${props.presentedTime / duration * 100}%` }} />}
    </div>
    <Slider value={cuts} min={0} max={duration} step={0.001} disabled={props.disabled || props.frameTable === null} onKeyDownCapture={(event) => {
      if (props.disabled || props.frameTable === null || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const index = [...event.currentTarget.querySelectorAll('[role=slider]')].indexOf(target);
      const at = normalized[index];
      if (at === undefined) return;
      event.preventDefault(); event.stopPropagation();
      const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowDown';
      const covering = planVideoFrames(props.frameTable, { mode: 'current', currentTime: at })[0];
      const neighbour = backwards ? (covering.pts < at ? covering.frameIndex : covering.frameIndex - 1) : (covering.pts > at ? covering.frameIndex : covering.frameIndex + 1);
      const pts = neighbour >= 0 && neighbour < presentationFrameCount(props.frameTable) ? presentationFrameAt(props.frameTable, neighbour).pts : undefined;
      const next = pts !== undefined && pts > 0 && pts < duration ? pts : undefined;
      if (next !== undefined) props.onChange({ ...draft, params: { ...draft.params, cuts: normalized.map((pts, position) => position === index ? next : pts) } });
    }} onPointerDownCapture={() => { gesture.current = draft.revision; }} onValueChange={(values) => setTemporary(values)} onValueCommit={(values) => {
      const current = latest.current.draft as VideoToolDraftById['video.split'];
      if (gesture.current !== current.revision || latest.current.disabled || latest.current.frameTable === null) { setTemporary(null); return; }
      gesture.current = null;
      const segments = planVideoSplit(latest.current.frameTable, values);
      props.onChange({ ...current, params: { ...current.params, cuts: segments.slice(1).map((segment) => segment.start) } });
      setTemporary(null);
    }} />
    <Slider value={props.presentedTime === null ? [] : [props.presentedTime]} min={0} max={duration} step={0.001} disabled={props.onSeek === undefined || props.presentedTime === null} onValueChange={(values) => { if (values[0] !== undefined) props.onSeek?.(values[0]); }} />
  </div>;
}

interface FrameCardsProps { source: VideoPresentationSource | null; frames: readonly { frameIndex: number; pts: number; displayEnd: number }[]; aspect: number; onSeek?: (time: number) => void }

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
  return <div className='grid gap-2'><div className='flex justify-center gap-2'>{props.frames.map((frame) => {
    const image = decoded.frames.find((item) => item.frameIndex === frame.frameIndex);
    return <Button key={frame.frameIndex} variant={null} size={null} className='grid w-full min-w-0 overflow-hidden rounded-chrome border border-border text-left' onClick={() => props.onSeek?.(frame.pts)}><span className='relative block w-full bg-muted' style={{ aspectRatio: props.aspect }}>{image === undefined ? <Skeleton className='absolute inset-0 size-full' /> : <img src={image.url} alt='' data-frame-time={frame.pts} className='absolute inset-0 size-full object-contain object-center' />}</span><span className='px-2 py-1 text-xs tabular-nums'>{frame.pts.toFixed(3)} s</span></Button>;
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
