// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import { ArrowLeftRight, Film, Pause, Play } from 'lucide-react';
import { planVideoTimelineSeconds, transitionDurationBounds, type VideoFrameRate, type VideoPresentationTable, type VideoToolDraftById, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { plannedRunRefusalText } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { VideoNumericInput } from '@web/spaces/canvas/mini-tool/video/VideoToolControls';
import { moveTimelineClip, trimTimelineClip } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import type { VideoTimelineDecoderRenderer } from '@web/spaces/canvas/mini-tool/video/video-timeline-decoder';
import { VideoTimelinePreview } from '@web/spaces/canvas/mini-tool/video/VideoTimelinePreview';

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
  renderDecoder?: VideoTimelineDecoderRenderer;
}

const TRANSITION_KEYS = { cut: 'transitionCut', fade: 'transitionFade', wipeLeft: 'transitionWipeLeft', wipeRight: 'transitionWipeRight' } as const;

/**
 * A compact table's frame rate (frames-split §7.17 transition output profile row): a constant-rate table's timescale over its frame step,
 * otherwise its frame count over its presented duration.
 * @param table - The table.
 * @returns The rate, exact.
 * @throws {never} Never.
 */
function tableFrameRate(table: VideoPresentationTable): VideoFrameRate {
  const step = table.runs[0]!.step;
  if (table.runs.every((run) => run.step === step || run.count === 1)) return { numerator: String(table.timescale), denominator: String(step) };
  const frames = table.runs.reduce((sum, run) => sum + run.count, 0);
  const last = table.runs.at(-1)!;
  return { numerator: String(frames * table.timescale), denominator: String(last.start + (last.count - 1) * last.step + last.duration - table.runs[0]!.start) };
}

/**
 * Keeps each clip's transition no longer than half the shorter clip and the last clip's a Cut.
 * @throws {never} Never.
 * @param clips - The full ordered source clip sequence.
 * @returns The current value derived from these inputs.
 */
function normalize(clips: readonly VideoToolTimelineClip[]): VideoToolTimelineClip[] {
  return clips.map((clip, index) => {
    const next = clips[index + 1];
    const maximum = next === undefined ? 0 : Math.min(clip.out - clip.in, next.out - next.in) / 2;
    return { ...clip, transition: { kind: maximum === 0 ? 'cut' : clip.transition.kind, duration: clip.transition.kind === 'cut' ? 0 : Math.min(maximum, clip.transition.duration) } };
  });
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
  const plan = planVideoTimelineSeconds(draft.params.clips);
  const clips = draft.params.clips;
  const clip = clips.find((item) => item.clipId === selected) ?? clips[0];
  const input = draft.inputs.find((item) => item.inputId === clip?.inputId);
  // The one transition sits between the two clips and is carried by the first (demo editJunction).
  const junction = clips.length === 2 ? clips[0]! : null;
  const firstTable = clips[0] === undefined ? undefined : props.inputTables?.get(clips[0].inputId);
  // The output grid is the first clip's rate (D13-1); without its table no transition length can be judged yet.
  const bounds = React.useMemo(() => (junction === null || firstTable === undefined ? null : transitionDurationBounds(clips, tableFrameRate(firstTable))), [junction, firstTable, clips]);
  const width = Math.max(900, Math.ceil(plan.duration + 1) * 100 + 32);
  const rows: React.ComponentProps<typeof Timeline>['editorData'] = [{ id: 'video', actions: plan.clips.map((item) => ({ id: item.clipId, start: item.start, end: item.end, effectId: 'video', selected: item.clipId === clip?.clipId, minStart: Math.max(0, item.start - item.in), maxEnd: item.end + (draft.inputs.find((asset) => asset.inputId === item.inputId)?.mediaInfo?.duration ?? item.out) - item.out, flexible: !props.disabled, movable: !props.disabled })) }];
  React.useEffect(() => { setPlaying(false); setCursor((value) => Math.min(value, plan.duration)); }, [draft.revision, plan.duration]);
  React.useEffect(() => { timeline.current?.setTime(cursor); }, [cursor]);
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
    props.onChange({ ...draft, params: { clips: normalize(next) } });
  }
  /**
   * Edits only the selected clip's owned source properties.
   * @throws {never} Never.
   * @param partial - Only the fields changed by this edit.
   */
  function edit(partial: Partial<VideoToolTimelineClip>): void {
    if (clip === undefined) return;
    commit(clips.map((item) => item.clipId === clip.clipId ? { ...item, ...partial } : item), clip.clipId);
  }
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
  function seek(time: number): void { setPlaying(false); setCursor(Math.min(plan.duration, Math.max(0, time))); }
  /**
   * Exports, or says why it cannot: an accepted export returns to the panel, a refused one stays here with its reason.
   * @throws {never} The run's own failure path reports request failures.
   */
  async function exportTimeline(): Promise<void> {
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
      <section className='grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 bg-background p-4'><div className='flex items-center justify-between gap-2'><h3 className='text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineComposition')}</h3><span className='text-xs tabular-nums'>{plan.duration.toFixed(3)} s</span></div><VideoTimelinePreview renderDecoder={props.renderDecoder} plan={plan} inputs={draft.inputs} cursor={cursor} onCursorChange={setCursor} playing={playing} onPlayingChange={setPlaying} /></section>
      <aside className='grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-border'><h3 className='border-b border-border p-3 text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineProperties')}</h3><ScrollArea className='min-h-0' viewportClassName='p-3'>{clip === undefined ? <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.selectedClipEmpty')}</p> : <fieldset disabled={props.disabled} className='grid gap-3'>
        <Select value={clip.clipId} onValueChange={setSelected}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{clips.map((item, index) => <SelectItem key={item.clipId} value={item.clipId}>{index + 1}. {props.inputNames.get(item.inputId)}</SelectItem>)}</SelectContent></Select>
        <div className='grid grid-cols-2 gap-2'><label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.inPoint')}<VideoNumericInput key={`${clip.clipId}:in`} onInvalidChange={invalidChange} value={clip.in} label={t('canvas.miniTool.videoUI.inPoint')} testId='video-clip-in' exclusiveMax min={0} max={clip.out} disabled={props.disabled} onChange={(value) => { if (value < clip.out) edit({ in: value }); }} /></label><label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.outPoint')}<VideoNumericInput key={`${clip.clipId}:out`} onInvalidChange={invalidChange} value={clip.out} label={t('canvas.miniTool.videoUI.outPoint')} testId='video-clip-out' exclusiveMin min={clip.in} max={input?.mediaInfo?.duration} disabled={props.disabled} onChange={(value) => { if (value > clip.in) edit({ out: value }); }} /></label></div>
        {junction === null ? null : <>
          <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.transition')}<Select value={junction.transition.kind} disabled={props.disabled} onValueChange={(kind) => {
            if (kind !== 'cut' && bounds === null) { toast.warning(t('canvas.miniTool.videoUI.transitionTooShort')); return; }
            editJunction({ kind: kind as typeof junction.transition.kind, duration: kind === 'cut' || bounds === null ? 0 : Math.min(bounds.max, Math.max(bounds.min, junction.transition.duration || bounds.max)) });
          }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['cut', 'fade', 'wipeLeft', 'wipeRight'] as const).map((kind) => <SelectItem key={kind} value={kind} aria-disabled={kind !== 'cut' && bounds === null ? true : undefined} className='aria-disabled:opacity-50'>{t(`canvas.miniTool.videoUI.${TRANSITION_KEYS[kind]}`)}</SelectItem>)}</SelectContent></Select></label>
          {junction.transition.kind === 'cut' || bounds === null ? null : <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.transitionDuration')}<VideoNumericInput key={`${junction.clipId}:overlap`} onInvalidChange={invalidChange} value={junction.transition.duration} label={t('canvas.miniTool.videoUI.transitionDuration')} testId='video-clip-overlap' min={0} disabled={props.disabled} onChange={(duration) => editJunction({ ...junction.transition, duration: Math.min(bounds.max, Math.max(bounds.min, duration)) })} /></label>}
        </>}
      </fieldset>}</ScrollArea></aside>
    </div>
    <section className='grid min-w-0 gap-2 px-4 py-3'>
      <div className='flex items-center justify-between gap-3'><div className='flex items-center gap-2'><Button variant='outline' size='compact' disabled={clips.length === 0} icon={playing ? <Pause className='size-3.5' /> : <Play className='size-3.5' />} onClick={() => { if (!playing && cursor >= plan.duration) setCursor(0); setPlaying((value) => !value); }}>{t(playing ? 'canvas.miniTool.videoUI.pause' : 'canvas.miniTool.videoUI.preview')}</Button><span className='text-xs tabular-nums'>{cursor.toFixed(3)} / {plan.duration.toFixed(3)} s</span></div><Button variant='outline' size='sm' disabled={junction === null || props.disabled} icon={<ArrowLeftRight className='size-3.5' />} onClick={swap}>{t('canvas.miniTool.videoUI.swapClips')}</Button></div>
      <Slider value={[cursor]} min={0} max={plan.duration || 1} step={0.001} disabled={clips.length === 0} onValueChange={(values) => seek(values[0] ?? 0)} />
      <ScrollArea scrollbars='horizontal' className='h-36 rounded-content-sm border border-border'><div className='[&_.ReactVirtualized__Grid]:!overflow-hidden [&_.timeline-editor]:!bg-background [&_.timeline-editor-time-area]:!bg-background [&_.timeline-editor-time-unit]:!border-border [&_.timeline-editor-time-unit-scale]:!text-muted-foreground [&_.timeline-editor-edit-row]:!bg-none [&_.timeline-editor-edit-row]:!bg-background [&_.timeline-editor-action]:!border-border [&_.timeline-editor-action]:!bg-accent [&_.timeline-editor-action-selected]:!border-active-border' style={{ width }}><Timeline key={`${draft.revision}:${cancelledGesture}`} ref={timeline} editorData={structuredClone(rows)} effects={{ video: { id: 'video', name: 'Video' } }} scale={1} scaleWidth={100} startLeft={32} rowHeight={82} minScaleCount={Math.ceil(plan.duration) + 1} maxScaleCount={Math.ceil(plan.duration) + 1} enableRowDrag={false} disableDrag={props.disabled} gridSnap={false} autoScroll={false} autoReRender style={{ width, height: 130 }} onClickTimeArea={(value) => { seek(value); return true; }} onCursorDrag={seek} onClickActionOnly={(_event, value) => { setSelected(value.action.id); seek(value.time); }} onActionMoveStart={() => { gesture.current = draft.revision; setPlaying(false); }} onActionResizeStart={() => { gesture.current = draft.revision; setPlaying(false); }} onActionMoveEnd={(value) => { if (gesture.current !== latest.current.draft.revision || latest.current.disabled) return; gesture.current = null; commit(moveTimelineClip(clips, value.action.id, value.start, value.end), value.action.id); }} onActionResizeEnd={(value) => { if (gesture.current !== latest.current.draft.revision || latest.current.disabled) return; gesture.current = null; commit(trimTimelineClip(clips, value.action.id, value.start, value.end), value.action.id); }} getActionRender={(action) => <div className='grid h-full content-center gap-1 px-2 text-xs'><span className='truncate'>{props.inputNames.get(clips.find((item) => item.clipId === action.id)?.inputId ?? '')}</span><span className='tabular-nums text-muted-foreground'>{action.start.toFixed(2)} – {action.end.toFixed(2)}</span></div>} /></div></ScrollArea>
      <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.timelineInstructions')}</p>
    </section>
    <footer className='flex items-center justify-between border-t border-border px-4 py-3'><span className='text-xs text-status-error-foreground'>{invalidFields.size === 0 ? '' : t('canvas.miniTool.videoUI.invalidNumber')}</span><Button variant='outline' size='sm' aria-disabled={props.runBlockedReason === undefined ? undefined : true} disabled={props.disabled || clips.length === 0 || invalidFields.size > 0} loading={exporting} className='aria-disabled:opacity-50' icon={<Film className='size-3.5' />} onClick={() => { void exportTimeline(); }}>{t('canvas.miniTool.videoUI.export')}</Button></footer>
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
