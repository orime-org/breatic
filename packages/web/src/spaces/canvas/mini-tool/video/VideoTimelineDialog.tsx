// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { ArrowLeftRight, Film, Pause, Play, RotateCcw } from 'lucide-react';
import { clampTransitions, planVideoTimelineSeconds, presentationOutputFps, transitionDurationBounds, type VideoPresentationTable, type VideoToolDraftById, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { plannedRunRefusalText } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { FilmStrip } from '@web/spaces/canvas/mini-tool/FilmStrip';
import { VideoNumericInput } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import { trimTimelineClip } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import type { VideoTimelineDecoderRenderer } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';
import { VideoTimelinePreview, type VideoTimelineFormat } from '@web/spaces/canvas/mini-tool/video/VideoTimelinePreview';

export interface VideoTimelineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: VideoToolDraftById['video.transitions'];
  onChange: (draft: VideoToolDraftById['video.transitions']) => void;
  inputNames: ReadonlyMap<string, string>;
  disabled: boolean;
  /** Exports; resolves with the press outcome. */
  onRun: () => Promise<unknown> | undefined;
  /** Why the panel's Run cannot run now; Export says it instead of exporting (canvas design §10 editor × export). */
  runBlockedReason?: string;
  /** Each input's selected compact presentation table, by input id (§97 D10-3). */
  inputTables?: ReadonlyMap<string, VideoPresentationTable>;
  /** Each input's selected display size and whether it presents with transparency, by input id. */
  inputFormats?: ReadonlyMap<string, VideoTimelineFormat>;
  renderDecoder?: VideoTimelineDecoderRenderer;
}

const TRANSITION_KEYS = { cut: 'transitionCut', fade: 'transitionFade', wipeLeft: 'transitionWipeLeft', wipeRight: 'transitionWipeRight' } as const;
// A Cut switched to another type starts this long, within its bounds (demo timeline-editor.tsx transition select).
const FIRST_TRANSITION_SECONDS = 0.4;

/**
 * A frame rate as the composition row shows it: at most two decimals, trailing zeros dropped (30, 29.97, 23.98).
 * @param fps - The exact rate.
 * @param fps.numerator - Its numerator.
 * @param fps.denominator - Its denominator.
 * @returns The text.
 * @throws {never} Never.
 */
function fpsText(fps: { numerator: string; denominator: string }): string {
  return String(Number((Number(fps.numerator) / Number(fps.denominator)).toFixed(2)));
}

/**
 * The clips after a Dialog edit, each junction keeping its type with its length held within its duration range on the output
 * grid of the first clip's table (frames-split §7.17), or by half the shorter clip while that table is unknown, and made a
 * Cut only when no transition fits (shared `clampTransitions`).
 * @param clips - The full ordered source clip sequence.
 * @param tables - Each input's selected presentation table, by input id.
 * @returns The clips, each junction held or made a Cut.
 * @throws {never} Never.
 */
function normalize(clips: readonly VideoToolTimelineClip[], tables: ReadonlyMap<string, VideoPresentationTable> | undefined): VideoToolTimelineClip[] {
  const table = clips[0] === undefined ? undefined : tables?.get(clips[0].inputId);
  const fps = table === undefined ? null : presentationOutputFps(table);
  const clamped = clampTransitions(clips, fps);
  const bounds = fps === null ? null : transitionDurationBounds(clamped, fps);
  if (bounds === null) return clamped;
  const grid = gridBounds(bounds);
  return clamped.map((item, index) => index === 0 && item.transition.kind !== 'cut'
    ? { ...item, transition: { ...item.transition, duration: Math.min(grid.max, Math.max(grid.min, Math.round(item.transition.duration * 1e6) / 1e6)) } } : item);
}

/**
 * Transition length bounds on the whole-microsecond grid, which both what the Dialog stores and what its field clamps to
 * use, so the field always shows the stored length: a bound that is no whole number of microseconds (1001/30000 s) is
 * taken up for the minimum and down for the maximum, and bounds with no whole microsecond between them (a two-frame clip)
 * become the nearest one, which shared `fitTransitions` accepts.
 * @param bounds - The exact bounds.
 * @param bounds.min - The shortest length.
 * @param bounds.max - The longest length.
 * @returns The bounds on the grid.
 * @throws {never} Never.
 */
function gridBounds(bounds: { min: number; max: number }): { min: number; max: number } {
  const low = Math.ceil(bounds.min * 1e6 - 1e-6) / 1e6;
  const high = Math.floor(bounds.max * 1e6 + 1e-6) / 1e6;
  if (low <= high) return { min: low, max: high };
  const nearest = Math.round(bounds.min * 1e6) / 1e6;
  return { min: nearest, max: nearest };
}

/**
 * Owns playback and selection only during the dialog's visible lifetime: the current video and the picked input, one
 * transition between them, and one control that swaps their order (canvas design §4 transitions row; tools design §58).
 * @throws {Error} When the supplied timeline draft is invalid.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
function TimelineWorkspace(props: VideoTimelineDialogProps): React.JSX.Element {
  const t = useTranslation();
  const { draft } = props;
  const latest = React.useRef(props);
  latest.current = props;
  const [invalidFields, setInvalidFields] = React.useState<ReadonlySet<string>>(new Set());
  const invalidChange = React.useCallback((key: string, invalid: boolean): void => {
    setInvalidFields((before) => { const next = new Set(before); if (invalid) next.add(key); else next.delete(key); return next.size === before.size && [...next].every((value) => before.has(value)) ? before : next; });
  }, []);
  const [selected, setSelected] = React.useState(draft.params.clips[0]?.clipId ?? '');
  const [cursor, setCursor] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [cancelledGesture, setCancelledGesture] = React.useState(0);
  const timeline = React.useRef<TimelineState>(null);
  const gesture = React.useRef<string | null>(null);
  const plan = React.useMemo(() => planVideoTimelineSeconds(draft.params.clips), [draft.params.clips]);
  const clips = draft.params.clips;
  const clip = clips.find((item) => item.clipId === selected) ?? clips[0];
  const selectedSourceLength = clip === undefined ? undefined : draft.inputs.find((input) => input.inputId === clip.inputId)?.mediaInfo?.duration;
  const input = draft.inputs.find((item) => item.inputId === clip?.inputId);
  // The one transition sits between the two clips and is carried by the first (demo editJunction).
  const junction = clips.length === 2 ? clips[0]! : null;
  const firstTable = clips[0] === undefined ? undefined : props.inputTables?.get(clips[0].inputId);
  // The output grid is the first clip's rate (D13-1); without its table no transition length can be judged yet.
  const bounds = React.useMemo(() => {
    const exact = junction === null || firstTable === undefined ? null : transitionDurationBounds(clips, presentationOutputFps(firstTable));
    return exact === null ? null : gridBounds(exact);
  }, [junction, firstTable, clips]);
  const firstInput = clips[0] === undefined ? undefined : draft.inputs.find((item) => item.inputId === clips[0]!.inputId);
  const firstFormat = clips[0] === undefined ? undefined : props.inputFormats?.get(clips[0].inputId);
  const frameWidth = firstFormat?.width ?? firstInput?.mediaInfo?.width;
  const frameHeight = firstFormat?.height ?? firstInput?.mediaInfo?.height;
  // The output is transparent when either clip is, as export decides (canvas design §4 transitions row).
  const transparent = clips.some((item) => props.inputFormats?.get(item.inputId)?.transparent === true);
  const format = React.useMemo((): VideoTimelineFormat | null => (frameWidth === undefined || frameHeight === undefined ? null : { width: frameWidth, height: frameHeight, transparent }), [frameWidth, frameHeight, transparent]);
  const compositionText = [format === null ? null : `${format.width} × ${format.height}`, firstTable === undefined ? null : `${fpsText(presentationOutputFps(firstTable))} fps`, `${plan.duration.toFixed(3)} s`].filter((part) => part !== null).join(' · ');
  // The editor labels every scale boundary, the last one included, and that last boundary is its right edge, where the
  // centred label is cut in half: that boundary stays unlabelled.
  const scaleCount = Math.ceil(plan.duration) + 1;
  const width = Math.max(900, scaleCount * 100 + 32);
  const selectedId = clip?.clipId;
  // The editor re-syncs whenever its data changes reference, so the data is rebuilt only when the clips, inputs, selection,
  // write permission or mount change; each mount (a new revision or a cancelled drag) gets a fresh clone, because the
  // editor mutates its actions during a resize.
  const track = React.useMemo(() => {
    const rows: React.ComponentProps<typeof Timeline>['editorData'] = [{ id: 'video', actions: plan.clips.map((item) => ({ id: item.clipId, start: item.start, end: item.end, effectId: 'video', selected: item.clipId === selectedId, minStart: Math.max(0, item.start - item.in), maxEnd: item.end + (draft.inputs.find((asset) => asset.inputId === item.inputId)?.mediaInfo?.duration ?? item.out) - item.out, flexible: !props.disabled, movable: false })) }];
    return { key: `${draft.revision}:${cancelledGesture}`, editorData: structuredClone(rows) };
  }, [plan.clips, selectedId, draft.inputs, draft.revision, props.disabled, cancelledGesture]);
  // Read through a ref so the effect below runs per mount and duration, not per frame.
  const cursorNow = React.useRef(cursor);
  cursorNow.current = cursor;
  // A new mount's playhead starts at 0 and the editor has no initial-time prop, so setTime is how it reaches the cursor.
  React.useEffect(() => {
    const clamped = Math.min(cursorNow.current, plan.duration);
    setPlaying(false);
    setCursor(clamped);
    timeline.current?.setTime(clamped);
  }, [track.key, plan.duration]);
  // The cursor reaches the track's own clock as it moves, never through an effect on every frame.
  const moveCursor = React.useCallback((time: number): void => { setCursor(time); timeline.current?.setTime(time); }, []);
  React.useEffect(() => {
    /**
     * Cancels a drag that no longer owns focus or write permission.
     * @throws {never} Never.
     */
    function cancel(): void { gesture.current = null; setCancelledGesture((value) => value + 1); setPlaying(false); }
    window.addEventListener('blur', cancel);
    if (props.disabled) cancel();
    return () => window.removeEventListener('blur', cancel);
  }, [props.disabled]);
  // The transition as it was when an In or Out began to be typed: every key re-fits that one, so a key on the way to a
  // number (Out 2 on the way to 2.9) cannot shorten the transition or make it a Cut for good.
  const held = React.useRef<VideoToolTimelineClip['transition'] | null>(null);
  /**
   * Commits one complete editing operation and stops its old preview clock.
   * @throws {never} Never.
   * @param next - The complete next snapshot or sequence.
   * @param selection - The identity to keep selected after the edit.
   */
  function commit(next: readonly VideoToolTimelineClip[], selection = selected): void {
    if (props.disabled) return;
    setPlaying(false);
    setSelected(selection);
    // Any write ends a held transition; editPoint holds it again for the next key of the same entry.
    held.current = null;
    props.onChange({ ...draft, params: { clips: normalize(next, props.inputTables) } });
  }
  /**
   * Edits the selected clip's In or Out, the transition re-fitted from the one held since typing began.
   * @throws {never} Never.
   * @param partial - The In or the Out.
   */
  function editPoint(partial: Pick<Partial<VideoToolTimelineClip>, 'in' | 'out'>): void {
    if (clip === undefined) return;
    const base = held.current ?? clips[0]?.transition ?? null;
    commit(clips.map((item, index) => ({ ...item, ...(item.clipId === clip.clipId ? partial : {}), ...(index === 0 && base !== null ? { transition: base } : {}) })), clip.clipId);
    held.current = base;
  }
  /**
   * Ends an In or Out entry: the next one holds the transition as it then is.
   * @throws {never} Never.
   */
  function settlePoint(): void { held.current = null; }
  /**
   * Edits the one transition between the two clips, whichever clip is selected.
   * @throws {never} Never.
   * @param transition - The next transition.
   */
  function editJunction(transition: VideoToolTimelineClip['transition']): void {
    if (junction !== null) commit(clips.map((item, index) => index === 0 ? { ...item, transition } : item));
  }
  /**
   * Swaps the two clips; the transition stays between them, carried by the new first clip (demo swap()).
   * @throws {never} Never.
   */
  function swap(): void {
    if (junction === null) return;
    commit([{ ...clips[1]!, transition: junction.transition }, { ...junction, transition: { kind: 'cut', duration: 0 } }]);
  }
  /**
   * Seeks the single logical composition clock.
   * @throws {never} Never.
   * @param time - The requested composition time in seconds.
   */
  function seek(time: number): void { setPlaying(false); moveCursor(Math.min(plan.duration, Math.max(0, time))); }
  /**
   * Exports, or says why it cannot: an accepted export returns to the panel, a refused one stays here with its reason.
   * @throws {never} The run's own failure path reports request failures.
   */
  async function exportTimeline(): Promise<void> {
    if (invalidFields.size > 0) { toast.warning(t('canvas.miniTool.videoUI.invalidNumber')); return; }
    if (props.runBlockedReason !== undefined) { toast.warning(props.runBlockedReason); return; }
    setExporting(true);
    try {
      const outcome = await props.onRun() as { kind?: string; error?: unknown } | undefined;
      if (outcome?.kind === 'done') props.onOpenChange(false);
      else if (outcome?.kind === 'failed') toast.error(plannedRunRefusalText(outcome.error, t));
    } finally {
      setExporting(false);
    }
  }
  return <div className='grid min-h-0 flex-1 grid-rows-[minmax(280px,1fr)_auto_auto]'>
    <div className='grid min-h-0 grid-cols-[minmax(0,1fr)_232px] border-y border-border'>
      <section className='grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 bg-background p-4'><div className='flex items-center justify-between gap-2'><h3 className='text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineComposition')}</h3><span className='shrink-0 text-xs tabular-nums text-muted-foreground'>{compositionText}</span></div><VideoTimelinePreview renderDecoder={props.renderDecoder} format={format} plan={plan} inputs={draft.inputs} cursor={cursor} onCursorChange={moveCursor} playing={playing} onPlayingChange={setPlaying} /></section>
      <aside className='grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-border'><h3 className='border-b border-border p-3 text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineProperties')}</h3><ScrollArea className='min-h-0'><fieldset disabled={props.disabled} className='grid min-w-0'>{clip === undefined ? <p className='p-3 text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.selectedClipEmpty')}</p> : <div className='grid min-w-0 gap-3 p-3'>
        <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.selectedClip')}<Select value={clip.clipId} onValueChange={setSelected}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{clips.map((item, index) => <SelectItem key={item.clipId} value={item.clipId}>{index + 1}. {props.inputNames.get(item.inputId)}</SelectItem>)}</SelectContent></Select></label>
        <div data-testid='video-clip-lengths' className='grid gap-1 text-xs text-muted-foreground tabular-nums'>{selectedSourceLength === undefined ? null : <span>{t('canvas.miniTool.videoUI.sourceDuration')}: {selectedSourceLength.toFixed(2)} s</span>}<span>{t('canvas.miniTool.videoUI.clipDuration')}: {(clip.out - clip.in).toFixed(2)} s</span></div>
        <div className='grid grid-cols-2 gap-2'><label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.inPoint')}<VideoNumericInput key={`${clip.clipId}:in`} onInvalidChange={invalidChange} value={clip.in} label={t('canvas.miniTool.videoUI.inPoint')} testId='video-clip-in' exclusiveMax min={0} max={clip.out} disabled={props.disabled} onChange={(value) => editPoint({ in: value })} onSettle={settlePoint} /></label><label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.outPoint')}<VideoNumericInput key={`${clip.clipId}:out`} onInvalidChange={invalidChange} value={clip.out} label={t('canvas.miniTool.videoUI.outPoint')} testId='video-clip-out' exclusiveMin min={clip.in} max={input?.mediaInfo?.duration} disabled={props.disabled} onChange={(value) => editPoint({ out: value })} onSettle={settlePoint} /></label></div>
      </div>}
      <h3 className='border-y border-border p-3 text-xs font-medium'>{t('canvas.miniTool.videoUI.transitionBetween')}</h3>
      {junction === null ? null : <div className='grid min-w-0 gap-3 p-3'>
        <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.transition')}<Select value={junction.transition.kind} disabled={props.disabled} onValueChange={(kind) => {
          if (kind !== 'cut' && bounds === null) { toast.warning(t('canvas.miniTool.videoUI.transitionTooShort')); return; }
          editJunction({ kind: kind as typeof junction.transition.kind, duration: kind === 'cut' || bounds === null ? 0 : Math.min(bounds.max, Math.max(bounds.min, junction.transition.duration || FIRST_TRANSITION_SECONDS)) });
        }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['cut', 'fade', 'wipeLeft', 'wipeRight'] as const).map((kind) => <SelectItem key={kind} value={kind} aria-disabled={kind !== 'cut' && bounds === null ? true : undefined} className='aria-disabled:opacity-50'>{t(`canvas.miniTool.videoUI.${TRANSITION_KEYS[kind]}`)}</SelectItem>)}</SelectContent></Select></label>
        {junction.transition.kind === 'cut' || bounds === null ? null : <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.transitionDuration')}<VideoNumericInput key={`${junction.clipId}:overlap`} onInvalidChange={invalidChange} value={junction.transition.duration} label={t('canvas.miniTool.videoUI.transitionDuration')} testId='video-clip-overlap' min={bounds.min} max={bounds.max} clampOnSettle disabled={props.disabled} onChange={(duration) => editJunction({ ...junction.transition, duration })} /><span className='text-muted-foreground'>{t('canvas.miniTool.videoUI.overlapLimit', { limit: `${bounds.max.toFixed(2)} s` })}</span></label>}
      </div>}
      </fieldset></ScrollArea></aside>
    </div>
    <section className='grid min-w-0 gap-2 px-4 py-3'>
      <div className='flex items-center justify-between gap-3'><div className='flex items-center gap-2'><Button variant='ghost' size='compact' className='w-[var(--btn-compact)] px-0' aria-label={t('canvas.miniTool.videoUI.rewind')} disabled={clips.length === 0} onClick={() => seek(0)}><RotateCcw className='size-3.5' /></Button><Button variant='outline' size='compact' disabled={clips.length === 0} icon={playing ? <Pause className='size-3.5' /> : <Play className='size-3.5' />} onClick={() => { if (!playing && cursor >= plan.duration) moveCursor(0); setPlaying((value) => !value); }}>{t(playing ? 'canvas.miniTool.videoUI.pause' : 'canvas.miniTool.videoUI.preview')}</Button><span className='text-xs tabular-nums'>{cursor.toFixed(3)} / {plan.duration.toFixed(3)} s</span></div><Button variant='outline' size='sm' disabled={junction === null || props.disabled} icon={<ArrowLeftRight className='size-3.5' />} onClick={swap}>{t('canvas.miniTool.videoUI.swapClips')}</Button></div>
      <Slider value={[cursor]} min={0} max={plan.duration || 1} step={0.001} disabled={clips.length === 0} onValueChange={(values) => seek(values[0] ?? 0)} />
      <ScrollArea scrollbars='horizontal' className='h-36 rounded-content-sm border border-border'><div className='[&_.timeline-editor]:!bg-background [&_.timeline-editor]:![font-family:inherit] [&_.timeline-editor-time-area]:!bg-background [&_.timeline-editor-time-unit]:!border-border [&_.timeline-editor-time-unit-scale]:!text-muted-foreground [&_.timeline-editor-edit-row]:!bg-none [&_.timeline-editor-edit-row]:!bg-background [&_.timeline-editor-action]:!rounded-chrome [&_.timeline-editor-action]:!bg-accent [&_.timeline-editor-action-selected]:z-[5] [&_.timeline-editor-action-selected]:!ring-1 [&_.timeline-editor-action-selected]:!ring-inset [&_.timeline-editor-action-selected]:!ring-active-border [&_.timeline-editor-action-left-stretch]:z-10 [&_.timeline-editor-action-right-stretch]:z-10' style={{ width }}><Timeline key={track.key} ref={timeline} editorData={track.editorData} effects={{ video: { id: 'video', name: 'Video' } }} scale={1} scaleWidth={100} startLeft={32} rowHeight={82} minScaleCount={scaleCount} maxScaleCount={scaleCount} enableRowDrag={false} disableDrag={props.disabled} gridSnap={false} autoScroll={false} autoReRender style={{ width, height: 130 }} onClickTimeArea={(value) => { seek(value); return true; }} onCursorDrag={seek} onClickActionOnly={(_event, value) => { setSelected(value.action.id); seek(value.time); }} onActionResizeStart={() => { gesture.current = draft.revision; setPlaying(false); }} onActionResizing={({ start, end }) => end > start} onActionResizeEnd={(value) => { if (gesture.current !== latest.current.draft.revision || latest.current.disabled) return; gesture.current = null; commit(trimTimelineClip(clips, value.action.id, value.start, value.end, draft.inputs.find((asset) => asset.inputId === clips.find((item) => item.clipId === value.action.id)?.inputId)?.mediaInfo?.duration), value.action.id); }} getActionRender={(action) => { const item = clips.find((candidate) => candidate.clipId === action.id); const asset = draft.inputs.find((candidate) => candidate.inputId === item?.inputId); const format = item === undefined ? undefined : props.inputFormats?.get(item.inputId); const aspect = format !== undefined ? format.width / format.height : asset?.mediaInfo?.width === undefined || asset.mediaInfo.height === undefined ? undefined : asset.mediaInfo.width / asset.mediaInfo.height; return item === undefined ? null : <div className='relative h-full w-full overflow-hidden rounded-chrome'>{asset === undefined || aspect === undefined ? null : <div className='absolute inset-0 opacity-50'><FilmStrip src={asset.url} start={item.in} duration={item.out - item.in} aspect={aspect} /></div>}<div className='absolute inset-x-0 bottom-0 grid gap-0.5 bg-popover px-2 py-1 text-xs'><span className='truncate font-medium'>{props.inputNames.get(item.inputId)}</span><span className='tabular-nums text-muted-foreground'>{item.in.toFixed(2)} s → {item.out.toFixed(2)} s</span></div></div>; }} getScaleRender={(value) => (value < scaleCount ? <span className='tabular-nums'>{value}s</span> : null)} /></div></ScrollArea>
    </section>
    <footer className='flex items-center justify-between gap-4 border-t border-border px-4 py-3'>{invalidFields.size === 0 ? <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.timelineExportHint')}</p> : <p className='text-xs text-status-error-foreground'>{t('canvas.miniTool.videoUI.invalidNumber')}</p>}<Button size='sm' aria-disabled={props.runBlockedReason === undefined && invalidFields.size === 0 ? undefined : true} disabled={props.disabled || clips.length === 0} loading={exporting} className='aria-disabled:opacity-50' icon={<Film className='size-3.5' />} onClick={() => { void exportTimeline(); }}>{t('canvas.miniTool.videoUI.export')}</Button></footer>
  </div>;
}

/**
 * Mounts the approved timeline workspace in the existing modal primitive.
 * @throws {never} Never.
 * @param props - The current values and the callbacks that own edits.
 * @returns The current value derived from these inputs.
 */
export function VideoTimelineDialog(props: VideoTimelineDialogProps): React.JSX.Element {
  const t = useTranslation();
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}><DialogContent className='h-[min(820px,calc(100vh-32px))] min-w-[960px] max-w-[1440px]' data-testid='video-timeline-dialog'><DialogHeader className='shrink-0'><DialogTitle>{t('canvas.miniTool.videoUI.editTimeline')}</DialogTitle><DialogDescription>{t('canvas.miniTool.videoUI.timelineInstructions')}</DialogDescription></DialogHeader>{props.open ? <TimelineWorkspace {...props} /> : null}</DialogContent></Dialog>;
}
