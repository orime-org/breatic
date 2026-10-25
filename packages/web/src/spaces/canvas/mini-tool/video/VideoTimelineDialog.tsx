// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { Timeline, type TimelineState } from '@xzdarcy/react-timeline-editor';
import { ArrowLeft, ArrowRight, Copy, Film, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { newId } from '@breatic/shared';
import { planVideoTimeline, type VideoToolDraftById, type VideoToolTimelineClip, type VideoToolInput } from '@breatic/shared/mini-tools';
import { Button } from '@web/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/components/ui/select';
import { Slider } from '@web/components/ui/slider';
import { useTranslation } from '@web/i18n/use-translation';
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
  onRun: () => void;
  renderDecoder?: VideoTimelineDecoderRenderer;
}

/**
 * Keeps source trims and outgoing overlaps within the approved adjacent ranges.
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
 * Owns playback and selection only during the dialog's visible lifetime.
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
  const [cancelledGesture, setCancelledGesture] = React.useState(0);
  const timeline = React.useRef<TimelineState>(null);
  const gesture = React.useRef<string | null>(null);
  const plan = planVideoTimeline(draft.params.clips);
  const clips = draft.params.clips;
  const clip = clips.find((item) => item.clipId === selected) ?? clips[0];
  const selectedIndex = clips.findIndex((item) => item.clipId === clip?.clipId);
  const input = draft.inputs.find((item) => item.inputId === clip?.inputId);
  const available = draft.inputs.some((item) => item.url === draft.source.canonicalURL) ? draft.inputs : [{ inputId: draft.source.nodeId, url: draft.source.canonicalURL, mediaInfo: draft.source.mediaInfo, sourceNodeId: draft.source.nodeId }, ...draft.inputs];
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
   * Seeks the single logical composition clock.
   * @throws {never} Never.
   * @param time - The requested composition time in seconds.
   */
  function seek(time: number): void { setPlaying(false); setCursor(Math.min(plan.duration, Math.max(0, time))); }
  /**
   * Reorders selected footage without changing its source trim.
   * @throws {never} Never.
   * @param delta - The adjacent position offset.
   */
  function move(delta: number): void {
    const target = selectedIndex + delta;
    if (clip === undefined || target < 0 || target >= clips.length) return;
    const next = [...clips];
    [next[selectedIndex], next[target]] = [next[target], next[selectedIndex]];
    commit(next, clip.clipId);
  }
  /**
   * Adds a copied input or restores the host's original source to the asset rail.
   * @param asset - The canonical video chosen from the available sources.
   * @throws {never} Never.
   */
  function addAsset(asset: VideoToolInput): void {
    if (props.disabled || asset.mediaInfo?.duration === undefined) return;
    const held = draft.inputs.find((item) => item.inputId === asset.inputId);
    const inputId = held?.inputId ?? newId();
    const clipId = newId();
    const nextClip: VideoToolTimelineClip = { clipId, inputId, in: 0, out: asset.mediaInfo.duration, transition: { kind: 'cut', duration: 0 } };
    setPlaying(false); setSelected(clipId);
    props.onChange({ ...draft, inputs: held === undefined ? [...draft.inputs, { ...asset, inputId }] : draft.inputs, params: { clips: normalize([...clips, nextClip]) } });
  }
  const next = clips[selectedIndex + 1];
  const overlap = clip === undefined || next === undefined ? 0 : Math.min(clip.out - clip.in, next.out - next.in) / 2;
  return <div className='grid min-h-0 flex-1 grid-rows-[minmax(280px,1fr)_auto_auto]'>
    <div className='grid min-h-0 grid-cols-[196px_minmax(0,1fr)_232px] border-y border-border'>
      <aside className='grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-border'><h3 className='border-b border-border p-3 text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineAssets')}</h3><ScrollArea className='min-h-0' viewportClassName='p-3'><div className='grid gap-3'>{available.map((asset) => <article key={asset.inputId} className='grid min-w-0 gap-2'>{asset.cover === undefined ? <Film className='size-8 text-muted-foreground' /> : <img src={asset.cover} alt='' className='aspect-video w-full rounded-content-sm object-contain' />}<p className='truncate text-xs'>{props.inputNames.get(asset.inputId) ?? t('canvas.miniTool.videoUI.video')}</p><Button variant='outline' size='sm' disabled={props.disabled || asset.mediaInfo?.duration === undefined} icon={<Plus className='size-3.5' />} onClick={() => addAsset(asset)}>{t('canvas.miniTool.videoUI.addToTimeline')}</Button></article>)}</div></ScrollArea></aside>
      <section className='grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 bg-background p-4'><div className='flex items-center justify-between gap-2'><h3 className='text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineComposition')}</h3><span className='text-xs tabular-nums'>{plan.duration.toFixed(3)} s</span></div><VideoTimelinePreview renderDecoder={props.renderDecoder} plan={plan} inputs={draft.inputs} cursor={cursor} onCursorChange={setCursor} playing={playing} onPlayingChange={setPlaying} /></section>
      <aside className='grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-border'><h3 className='border-b border-border p-3 text-xs font-medium'>{t('canvas.miniTool.videoUI.timelineProperties')}</h3><ScrollArea className='min-h-0' viewportClassName='p-3'>{clip === undefined ? <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.selectedClipEmpty')}</p> : <fieldset disabled={props.disabled} className='grid gap-3'>
        <Select value={clip.clipId} onValueChange={setSelected}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{clips.map((item, index) => <SelectItem key={item.clipId} value={item.clipId}>{index + 1}. {props.inputNames.get(item.inputId)}</SelectItem>)}</SelectContent></Select>
        <div className='grid grid-cols-2 gap-2'><label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.inPoint')}<VideoNumericInput key={`${clip.clipId}:in`} onInvalidChange={invalidChange} value={clip.in} label={t('canvas.miniTool.videoUI.inPoint')} testId='video-clip-in' exclusiveMax min={0} max={clip.out} disabled={props.disabled} onChange={(value) => { if (value < clip.out) edit({ in: value }); }} /></label><label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.outPoint')}<VideoNumericInput key={`${clip.clipId}:out`} onInvalidChange={invalidChange} value={clip.out} label={t('canvas.miniTool.videoUI.outPoint')} testId='video-clip-out' exclusiveMin min={clip.in} max={input?.mediaInfo?.duration} disabled={props.disabled} onChange={(value) => { if (value > clip.in) edit({ out: value }); }} /></label></div>
        <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.transition')}<Select value={clip.transition.kind} disabled={next === undefined || props.disabled} onValueChange={(kind) => edit({ transition: { kind: kind as typeof clip.transition.kind, duration: kind === 'cut' ? 0 : Math.min(overlap, clip.transition.duration || overlap) } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['cut', 'fade', 'wipeLeft', 'wipeRight'].map((kind) => <SelectItem key={kind} value={kind}>{kind}</SelectItem>)}</SelectContent></Select></label>
        {clip.transition.kind === 'cut' || next === undefined ? null : <label className='grid gap-1.5 text-xs'>{t('canvas.miniTool.videoUI.transitionDuration')}<VideoNumericInput key={`${clip.clipId}:overlap`} onInvalidChange={invalidChange} value={clip.transition.duration} label={t('canvas.miniTool.videoUI.transitionDuration')} testId='video-clip-overlap' min={0} max={overlap} disabled={props.disabled} onChange={(duration) => edit({ transition: { ...clip.transition, duration } })} /></label>}
        <div className='grid grid-cols-2 gap-2 border-t border-border pt-3'><Button variant='outline' size='sm' disabled={props.disabled || selectedIndex <= 0} onClick={() => move(-1)} icon={<ArrowLeft className='size-3' />}>{t('canvas.miniTool.videoUI.earlier')}</Button><Button variant='outline' size='sm' disabled={props.disabled || selectedIndex === clips.length - 1} onClick={() => move(1)} icon={<ArrowRight className='size-3' />}>{t('canvas.miniTool.videoUI.later')}</Button><Button variant='outline' size='sm' className='col-span-2' icon={<Copy className='size-3.5' />} onClick={() => { const clipId = newId(); const copy = [...clips]; copy.splice(selectedIndex + 1, 0, { ...clip, clipId }); commit(copy, clipId); }}>{t('canvas.miniTool.videoUI.duplicateClip')}</Button><Button variant='outline' size='sm' className='col-span-2' icon={<Trash2 className='size-3.5' />} onClick={() => { const next = clips.filter((item) => item.clipId !== clip.clipId); commit(next, next[Math.min(selectedIndex, next.length - 1)]?.clipId ?? ''); }}>{t('canvas.miniTool.videoUI.removeClip')}</Button></div>
      </fieldset>}</ScrollArea></aside>
    </div>
    <section className='grid min-w-0 gap-2 px-4 py-3'>
      <div className='flex items-center gap-2'><Button variant='outline' size='compact' disabled={clips.length === 0} icon={playing ? <Pause className='size-3.5' /> : <Play className='size-3.5' />} onClick={() => { if (!playing && cursor >= plan.duration) setCursor(0); setPlaying((value) => !value); }}>{t(playing ? 'canvas.miniTool.videoUI.pause' : 'canvas.miniTool.videoUI.preview')}</Button><span className='text-xs tabular-nums'>{cursor.toFixed(3)} / {plan.duration.toFixed(3)} s</span></div>
      <Slider value={[cursor]} min={0} max={plan.duration || 1} step={0.001} disabled={clips.length === 0} onValueChange={(values) => seek(values[0] ?? 0)} />
      <ScrollArea scrollbars='horizontal' className='h-36 rounded-content-sm border border-border'><div className='[&_.ReactVirtualized__Grid]:!overflow-hidden [&_.timeline-editor]:!bg-background [&_.timeline-editor-time-area]:!bg-background [&_.timeline-editor-time-unit]:!border-border [&_.timeline-editor-time-unit-scale]:!text-muted-foreground [&_.timeline-editor-edit-row]:!bg-none [&_.timeline-editor-edit-row]:!bg-background [&_.timeline-editor-action]:!border-border [&_.timeline-editor-action]:!bg-accent [&_.timeline-editor-action-selected]:!border-active-border' style={{ width }}><Timeline key={`${draft.revision}:${cancelledGesture}`} ref={timeline} editorData={structuredClone(rows)} effects={{ video: { id: 'video', name: 'Video' } }} scale={1} scaleWidth={100} startLeft={32} rowHeight={82} minScaleCount={Math.ceil(plan.duration) + 1} maxScaleCount={Math.ceil(plan.duration) + 1} enableRowDrag={false} disableDrag={props.disabled} gridSnap={false} autoScroll={false} autoReRender style={{ width, height: 130 }} onClickTimeArea={(value) => { seek(value); return true; }} onCursorDrag={seek} onClickActionOnly={(_event, value) => { setSelected(value.action.id); seek(value.time); }} onActionMoveStart={() => { gesture.current = draft.revision; setPlaying(false); }} onActionResizeStart={() => { gesture.current = draft.revision; setPlaying(false); }} onActionMoveEnd={(value) => { if (gesture.current !== latest.current.draft.revision || latest.current.disabled) return; gesture.current = null; commit(moveTimelineClip(clips, value.action.id, value.start, value.end), value.action.id); }} onActionResizeEnd={(value) => { if (gesture.current !== latest.current.draft.revision || latest.current.disabled) return; gesture.current = null; commit(trimTimelineClip(clips, value.action.id, value.start, value.end), value.action.id); }} getActionRender={(action) => <div className='grid h-full content-center gap-1 px-2 text-xs'><span className='truncate'>{props.inputNames.get(clips.find((item) => item.clipId === action.id)?.inputId ?? '')}</span><span className='tabular-nums text-muted-foreground'>{action.start.toFixed(2)} – {action.end.toFixed(2)}</span></div>} /></div></ScrollArea>
      <p className='text-xs text-muted-foreground'>{t('canvas.miniTool.videoUI.timelineInstructions')}</p>
    </section>
    <footer className='flex items-center justify-between border-t border-border px-4 py-3'><span className='text-xs text-status-error-foreground'>{invalidFields.size === 0 ? '' : t('canvas.miniTool.videoUI.invalidNumber')}</span><Button variant='outline' size='sm' disabled={props.disabled || clips.length === 0 || invalidFields.size > 0} icon={<Film className='size-3.5' />} onClick={props.onRun}>{t('canvas.miniTool.videoUI.export')}</Button></footer>
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
