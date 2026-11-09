// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { Code, Film, Trash2 } from 'lucide-react';
import { newId, TIMELINE_MAIN_TRACK_ID, type TimelineClip as TimelineClipRecord, type TimelineDocumentV1, type TimelineExecutionStatus, type TimelineWebResolution } from '@breatic/shared';
import { timelineClipSource } from '@web/data/yjs/timeline-arrangement';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { orderedTimelineClips, orderedTimelineTracks } from '@web/data/yjs/timeline-order';

import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { previewTimelineGesture, timelineGestureCommand, timelineInsertMarkerFrame, type TimelineGestureMode, type TimelineGesturePreview } from '@web/spaces/timeline/timeline-gesture';
import type { TimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';
import { formatTimelineTimecode } from '@web/spaces/timeline/timeline-timecode';
import { TIMELINE_TRACK_HEADER_PX, timelineRulerStep } from '@web/spaces/timeline/timeline-zoom';
import { useTimelineAsset } from '@web/spaces/timeline/use-timeline-asset';
import { timelineUploadText, type TimelineUploadView } from '@web/spaces/timeline/use-timeline-upload-views';

const DRAG_ACTIVATION_PX = 3;
const HEADER_STYLE = { width: TIMELINE_TRACK_HEADER_PX };
// Text that stays beside the sticky track headers while the lanes scroll: the zone hint, clip text, drop readouts.
const BESIDE_HEADERS = { left: TIMELINE_TRACK_HEADER_PX };
// The palette sits outside @theme, so its colours are written as arbitrary values; the `color:` hint tells Tailwind a var() is a colour.
const CLIP_FILL = {
  ready: 'border-[color:var(--color-palette-blue-border)] bg-[color:var(--color-palette-blue-bg)] hover-enabled:bg-[color:var(--color-palette-blue-highlight)]',
  web: 'border-[color:var(--color-palette-violet-border)] bg-[color:var(--color-palette-violet-bg)] hover-enabled:bg-[color:var(--color-palette-violet-highlight)]',
  conflict: 'border-status-error-border bg-status-error-bg hover-enabled:border-status-error',
};
const SELECTED_FILL = { video: 'bg-[color:var(--color-palette-blue-highlight)]', web: 'bg-[color:var(--color-palette-violet-highlight)]' };

/**
 * What a web-animation copy on a track shows: its picture is ready, its execution is still running, its execution
 * ended without a result, or its reference is not resolved yet; with the request it came from and its status.
 */
export interface TimelineWebClipView {
  state: 'ready' | 'pending' | 'failed' | 'unresolved';
  prompt: string | null;
  status: TimelineExecutionStatus | null;
  phase: 'writing' | 'validating' | 'saving' | null;
}

/** What the track area needs from the editor. */
interface TimelineTrackAreaProps {
  projectId: string;
  document: TimelineDocumentV1;
  labels: TimelineTrackLabels;
  readyIds: ReadonlySet<string>;
  selectedId: string | null;
  frame: number;
  extent: number;
  pixelsPerFrame: number;
  readOnly: boolean;
  snap: boolean;
  placement: TimelineEditPlacement;
  web: TimelineWebResolution;
  webClips: ReadonlyMap<string, TimelineWebClipView>;
  /** What each upload placeholder shows, by clip id. */
  uploads: ReadonlyMap<string, TimelineUploadView>;
  onSelect: (clipId: string | null) => void;
  onSeek: (frame: number) => void;
  onCommit: (command: TimelineEditCommand) => void;
  onVanished: () => void;
  onDraggingChange: (dragging: boolean) => void;
  viewportRef: React.Ref<HTMLDivElement>;
}

/** The active pointer gesture and its latest preview. */
interface Gesture { mode: TimelineGestureMode; clipId: string; preview: TimelineGesturePreview | null }

/** One clip on its track row. */
interface ClipProps {
  projectId: string;
  clip: TimelineClipRecord;
  assetId: string;
  webView: TimelineWebClipView | undefined;
  uploadView: TimelineUploadView | undefined;
  selected: boolean;
  conflict: boolean;
  dragging: boolean;
  readOnly: boolean;
  pixelsPerFrame: number;
  fps: TimelineDocumentV1['settings']['fps'];
  onSelect: (clipId: string) => void;
}

/**
 * A draggable edge handle that trims the selected clip.
 * @param props - The handle's clip and edge.
 * @param props.clipId - The trimmed clip.
 * @param props.mode - Which edge it trims.
 * @returns The handle.
 * @throws {never} Never.
 */
function TrimHandle({ clipId, mode }: { clipId: string; mode: 'trim-start' | 'trim-end' }): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `${mode}:${clipId}`, data: { mode, clipId } });
  // The transparent band either side widens what the pointer can catch; the visible bar stays 6px.
  return <div ref={setNodeRef} {...listeners} {...attributes} tabIndex={-1} role='presentation' data-testid={`timeline-${mode}-${clipId}`}
    className={cn('absolute inset-y-0 z-10 w-1.5 cursor-ew-resize bg-active-border before:absolute before:inset-y-0 before:-inset-x-2 before:content-[""]', mode === 'trim-start' ? 'left-0 rounded-l-chrome' : 'right-0 rounded-r-chrome')} />;
}

/**
 * One placed clip: click selects, drag moves, the selected clip shows trim handles.
 * @param props - The clip and its state.
 * @param props.projectId - The authorizing Project.
 * @param props.clip - The placement.
 * @param props.assetId - Its registered asset.
 * @param props.webView - What a web-animation copy shows.
 * @param props.uploadView - What an upload placeholder shows.
 * @param props.selected - Whether it is selected.
 * @param props.conflict - Whether the arrangement reports a conflict.
 * @param props.dragging - Whether a gesture is moving it.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.pixelsPerFrame - The current zoom.
 * @param props.fps - The Timeline's frame rate, for the clip's length.
 * @param props.onSelect - Selects the clip.
 * @returns The clip.
 * @throws {never} Never.
 */
const TimelineClip = React.memo(function TimelineClip({ projectId, clip, assetId, webView, uploadView, selected, conflict, dragging, readOnly, pixelsPerFrame, fps, onSelect }: ClipProps): React.JSX.Element {
  const t = useTranslation();
  const assetName = useTimelineAsset(projectId, assetId).data?.displayName || null;
  const isWeb = clip.kind === 'web-animation';
  const upload = clip.kind === 'upload' ? uploadView ?? null : null;
  const name = isWeb ? webView?.prompt || t('timeline.webAnimation.copy') : clip.kind === 'upload' ? clip.upload.name : assetName ?? t('timeline.video');
  const status = isWeb && (webView?.state === 'pending' || webView?.state === 'failed') ? webView.status : null;
  const phase = status === 'running' ? webView?.phase ?? null : null;
  const detail = upload !== null ? timelineUploadText(t, upload) : status === null ? formatTimelineTimecode(clip.durationFrames, fps)
    : phase === null ? t(`timeline.webAnimation.status.${status}`) : `${t(`timeline.webAnimation.status.${status}`)} · ${t(`timeline.webAnimation.phase.${phase}`)}`;
  const failedCopy = (isWeb && webView?.state === 'failed') || upload?.state === 'failed';
  const waiting = (isWeb && webView?.state === 'pending') || (upload !== null && upload.state !== 'failed');
  // Only the pointer listeners are used: the clip is already a focusable Button, and dnd-kit's
  // attributes would mark a read-only clip aria-disabled although it stays selectable.
  const { listeners, setNodeRef } = useDraggable({ id: `move:${clip.id}`, data: { mode: 'move', clipId: clip.id }, disabled: readOnly });
  const select = React.useCallback((): void => onSelect(clip.id), [onSelect, clip.id]);
  const style = React.useMemo(() => ({ left: clip.startFrame * pixelsPerFrame, width: Math.max(2, clip.durationFrames * pixelsPerFrame) }), [clip.startFrame, clip.durationFrames, pixelsPerFrame]);
  return <div className={cn('absolute inset-y-1', dragging && 'opacity-40')} style={style}>
    <Button ref={setNodeRef} {...(readOnly ? {} : listeners)} data-testid={`timeline-clip-${clip.id}`} data-clip-id={clip.id} data-track-id={clip.trackId} type='button' variant={null} size={null}
      data-kind={clip.kind} data-state={isWeb ? webView?.state ?? 'unresolved' : upload?.state} aria-pressed={selected} onClick={select} onFocus={select}
      className={cn('flex size-full min-w-0 flex-col items-start justify-center overflow-clip rounded-chrome border px-2 text-left text-xs',
        !readOnly && 'cursor-grab', conflict || failedCopy ? CLIP_FILL.conflict : isWeb ? CLIP_FILL.web : CLIP_FILL.ready, waiting && 'border-dashed',
        selected && 'border-active-border', selected && !conflict && !failedCopy && SELECTED_FILL[isWeb ? 'web' : 'video'])}>
      {/* overflow-clip keeps the button from becoming the scroller, so this text can stick beside the track headers. */}
      <span className='sticky flex min-w-0 max-w-full flex-col gap-0.5' style={BESIDE_HEADERS}>
        <span className='flex min-w-0 items-center gap-2'>
          {isWeb ? <Code className='size-4 shrink-0' /> : <Film className='size-4 shrink-0' />}
          <span className='min-w-0 truncate leading-normal'>{name}</span>
          {conflict && <span className='shrink-0 text-status-error-foreground'>{t('timeline.conflict')}</span>}
        </span>
        <span className={cn('truncate text-2xs tabular-nums', failedCopy ? 'text-status-error-foreground' : 'text-foreground-secondary')}>{detail}</span>
      </span>
    </Button>
    {selected && !readOnly && <><TrimHandle clipId={clip.id} mode='trim-start' /><TrimHandle clipId={clip.id} mode='trim-end' /></>}
  </div>;
});

/**
 * The delete control of an empty sub track.
 * @param props - The track and the commit callback.
 * @param props.trackId - The empty track.
 * @param props.placement - The editing user's switches.
 * @param props.onCommit - Commits the deletion.
 * @returns The button.
 * @throws {never} Never.
 */
function DeleteTrackButton({ trackId, placement, onCommit }: { trackId: string; placement: TimelineEditPlacement; onCommit: (command: TimelineEditCommand) => void }): React.JSX.Element {
  const t = useTranslation();
  const remove = React.useCallback((): void => onCommit({ operation: 'delete_track', parameters: { trackId }, placement }), [onCommit, trackId, placement]);
  return <Button data-testid={`timeline-delete-track-${trackId}`} variant='ghost' size='compact' className='ml-auto' onClick={remove} icon={<Trash2 className='mr-1.5 size-3.5' />}>{t('timeline.edit.deleteTrack')}</Button>;
}

/**
 * A drop row for one track, or the new-track zone.
 * @param props - The row identity and contents.
 * @param props.id - The droppable id: a track id or 'new'.
 * @param props.className - Row classes.
 * @param props.testId - The row's test id.
 * @param props.children - Header and lane.
 * @returns The row.
 * @throws {never} Never.
 */
function DropRow({ id, className, testId, children }: { id: string; className: string; testId: string; children: React.ReactNode }): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `row:${id}`, data: { hover: id } });
  return <div ref={setNodeRef} data-testid={testId} className={cn('flex border-b border-border', className, isOver && id === 'new' && 'bg-accent')}>{children}</div>;
}

/** The editor facts a drag preview reads at the moment it is computed. */
interface DragView { document: TimelineDocumentV1; web: TimelineWebResolution; frame: number; pixelsPerFrame: number; snap: boolean; placement: TimelineEditPlacement }

/**
 * The preview of a drag at its current pointer travel and hovered row.
 * @param view - The editor facts.
 * @param data - The dragged clip and mode.
 * @param data.mode - Move, or trim one edge.
 * @param data.clipId - The dragged clip.
 * @param event - The dnd-kit move or end event.
 * @returns The preview, or null when the clip no longer exists.
 * @throws {never} Never.
 */
function previewOf(view: DragView, data: { mode: TimelineGestureMode; clipId: string }, event: DragMoveEvent | DragEndEvent): TimelineGesturePreview | null {
  const hover = (event.over?.data.current as { hover?: string } | undefined)?.hover ?? null;
  return previewTimelineGesture(view.document, data.clipId, data.mode, Math.round(event.delta.x / view.pixelsPerFrame), hover,
    { snap: view.snap, pixelsPerFrame: view.pixelsPerFrame, playhead: view.frame, magnet: view.placement.magnet, web: view.web });
}

/**
 * The ruler, the track rows and their clips, with drag, trim, snap and the new-track zone.
 * @param props - The document view and editing callbacks.
 * @returns The scrollable track area.
 * @throws {never} Never.
 */
export function TimelineTrackArea(props: TimelineTrackAreaProps): React.JSX.Element {
  const { projectId, document, labels, readyIds, selectedId, frame, extent, pixelsPerFrame, readOnly, snap, placement, web, webClips, uploads, onSelect, onSeek, onCommit, onVanished, onDraggingChange, viewportRef } = props;
  const t = useTranslation();
  const [gesture, setGesture] = React.useState<Gesture | null>(null);
  const cancelled = React.useRef(false);
  const latest = React.useRef({ document, web, frame, pixelsPerFrame, snap, placement, readOnly });
  latest.current = { document, web, frame, pixelsPerFrame, snap, placement, readOnly };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_PX } }));
  const rows = React.useMemo(() => orderedTimelineTracks(document.tracks).reverse(), [document.tracks]);
  const width = extent * pixelsPerFrame;

  const startDrag = React.useCallback((event: DragStartEvent): void => {
    const data = event.active.data.current as { mode: TimelineGestureMode; clipId: string } | undefined;
    if (data === undefined || readOnly) return;
    cancelled.current = false;
    onSelect(data.clipId);
    setGesture({ mode: data.mode, clipId: data.clipId, preview: null });
  }, [onSelect, readOnly]);
  const moveDrag = React.useCallback((event: DragMoveEvent): void => {
    const data = event.active.data.current as { mode: TimelineGestureMode; clipId: string } | undefined;
    if (data === undefined || latest.current.readOnly || cancelled.current) return;
    setGesture({ mode: data.mode, clipId: data.clipId, preview: previewOf(latest.current, data, event) });
  }, []);
  const endDrag = React.useCallback((event: DragEndEvent): void => {
    const data = event.active.data.current as { mode: TimelineGestureMode; clipId: string } | undefined;
    setGesture(null);
    if (data === undefined || readOnly || cancelled.current) return;
    const view = latest.current;
    if (view.document.clips[data.clipId] === undefined) { onVanished(); return; }
    const preview = previewOf(view, data, event);
    if (preview === null) return;
    const command = timelineGestureCommand(view.document, preview, data.mode, view.placement, newId);
    if (command !== null) onCommit(command);
  }, [onCommit, onVanished, readOnly]);
  // dnd-kit keeps the drag going after a lost write access or a window blur, so the flag makes its later moves and
  // release ignored; Esc goes through the same path.
  const cancelDrag = React.useCallback((): void => { cancelled.current = true; setGesture(null); }, []);
  React.useEffect(() => { if (readOnly) cancelDrag(); }, [readOnly, cancelDrag]);
  const dragging = gesture !== null;
  React.useEffect(() => {
    onDraggingChange(dragging);
    return () => onDraggingChange(false);
  }, [dragging, onDraggingChange]);
  // Leaving the window ends a drag without writing (dnd-kit itself cancels only on Esc, resize and hidden pages).
  React.useEffect(() => {
    if (!dragging) return;
    window.addEventListener('blur', cancelDrag);
    return () => window.removeEventListener('blur', cancelDrag);
  }, [dragging, cancelDrag]);

  const clearOnBlank = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    // Blur first so a property field commits what was typed before its panel unmounts with the selection.
    if (window.document.activeElement instanceof HTMLElement) window.document.activeElement.blur();
    onSelect(null);
  }, [onSelect]);
  const seekFromRuler = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.round((event.clientX - bounds.left) / pixelsPerFrame)));
  }, [onSeek, pixelsPerFrame]);

  const fps = document.settings.fps.num / document.settings.fps.den;
  const seconds = Math.ceil(extent / fps);
  const labelStep = timelineRulerStep(fps, pixelsPerFrame, extent);
  const preview = gesture?.preview ?? null;
  const ghostStyle = React.useMemo(() => preview === null ? undefined : { left: preview.startFrame * pixelsPerFrame, width: Math.max(2, preview.durationFrames * pixelsPerFrame) }, [preview, pixelsPerFrame]);
  const ghostSpacer = React.useMemo(() => ({ width: (preview?.startFrame ?? 0) * pixelsPerFrame }), [preview, pixelsPerFrame]);
  const playheadStyle = React.useMemo(() => ({ left: frame * pixelsPerFrame }), [frame, pixelsPerFrame]);
  /**
   * The drop readout: it starts at the ghost and sticks inside the visible lanes, so a drop near either edge stays readable.
   * @param className - Where the readout row sits in its lane.
   * @returns The readout, or null without a preview.
   * @throws {never} Never.
   */
  const readout = (className: string): React.JSX.Element | null => preview === null ? null
    : <div className={cn('pointer-events-none absolute inset-x-0 flex', className)}>
      <span className='shrink-0' style={ghostSpacer} />
      <span data-testid='timeline-ghost-label' className='sticky right-0 shrink-0 whitespace-nowrap rounded-chrome border border-border bg-background px-1 text-2xs tabular-nums text-foreground' style={BESIDE_HEADERS}>
        {t('timeline.clipFrames', { start: preview.startFrame, duration: preview.durationFrames })}
        {gesture?.mode === 'move' && preview.trackId !== null && ` · ${t(preview.trackId === TIMELINE_MAIN_TRACK_ID && placement.magnet ? 'timeline.edit.ghostInsert' : 'timeline.edit.ghostOverwrite')}`}
      </span>
    </div>;
  const header = 'sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-border bg-background px-2 text-xs';

  return <DndContext sensors={sensors} onDragStart={startDrag} onDragMove={moveDrag} onDragEnd={endDrag} onDragCancel={cancelDrag} autoScroll={false}>
    <ScrollArea scrollbars='both' viewportRef={viewportRef} className='h-full min-h-0 border-t border-border'>
      <div style={{ width: width + TIMELINE_TRACK_HEADER_PX }} className='relative min-w-full'>
        <div className='sticky top-0 z-30 flex h-6 border-b border-border bg-background'>
          <div className={header} style={HEADER_STYLE} />
          <div data-testid='timeline-ruler' className='relative flex-1 cursor-pointer' onPointerDown={seekFromRuler}>
            {Array.from({ length: Math.floor(seconds / labelStep) + 1 }, (_, index) => index * labelStep).map((second) => <span key={second} className='absolute inset-y-0 border-l border-border pl-1 text-2xs tabular-nums text-muted-foreground' style={{ left: second * fps * pixelsPerFrame }}>{second}s</span>)}
            <div data-testid='timeline-playhead-head' className='pointer-events-none absolute bottom-0 h-2 w-3 -translate-x-1/2 bg-foreground [clip-path:polygon(0_0,100%_0,50%_100%)]' style={playheadStyle} />
          </div>
        </div>
        {!readOnly && <DropRow id='new' testId='timeline-new-track-zone' className='h-7 border-dashed'>
          <div className={header} style={HEADER_STYLE} />
          <div className='relative flex flex-1 items-center text-2xs text-muted-foreground'>
            {gesture?.mode === 'move' && <span className='sticky px-2 text-foreground-secondary' style={BESIDE_HEADERS}>{t('timeline.edit.newTrackZone')}</span>}
            {preview !== null && preview.trackId === null && <>
              <div className='pointer-events-none absolute inset-y-1 rounded-chrome border border-active-border bg-muted/60' style={ghostStyle} />
              {readout('inset-y-1 items-center')}
            </>}
          </div>
        </DropRow>}
        {rows.map((track) => {
          const clips = orderedTimelineClips(document.clips, track.id);
          const isMain = track.id === TIMELINE_MAIN_TRACK_ID;
          const showGhost = preview !== null && (preview.trackId ?? '') === track.id;
          return <DropRow key={track.id} id={track.id} testId={`timeline-track-${track.id}`} className={isMain ? 'h-16' : 'h-12'}>
            <div className={header} style={HEADER_STYLE}>
              <span className='flex min-w-0 flex-col items-start gap-0.5'>
                <span className='max-w-full truncate'>{labels.nameOf(track.id) ?? track.id}</span>
                {isMain && <Badge variant='outline' className='border-border bg-card px-1.5 py-0 text-2xs leading-5 text-muted-foreground'>{placement.magnet ? t('timeline.edit.magnetOn') : t('timeline.edit.magnetOff')}</Badge>}
              </span>
              {!isMain && !readOnly && clips.length === 0 && <DeleteTrackButton trackId={track.id} placement={placement} onCommit={onCommit} />}
            </div>
            <div data-testid={`timeline-lane-${track.id}`} className='relative flex-1' onPointerDown={clearOnBlank}>
              {clips.map((clip) => <TimelineClip key={clip.id} projectId={projectId} clip={clip} assetId={timelineClipSource(document.sources, clip)?.assetId ?? ''}
                webView={webClips.get(clip.id)} uploadView={uploads.get(clip.id)} selected={selectedId === clip.id} conflict={!readyIds.has(clip.id)} dragging={gesture?.clipId === clip.id && preview !== null}
                readOnly={readOnly} pixelsPerFrame={pixelsPerFrame} fps={document.settings.fps} onSelect={onSelect} />)}
              {showGhost && preview !== null && <>
                <div className='pointer-events-none absolute inset-y-1 rounded-chrome border border-active-border bg-muted/60' style={ghostStyle} />
                {readout('-top-5')}
              </>}
              {showGhost && isMain && placement.magnet && gesture?.mode === 'move' && <div data-testid='timeline-insert-marker' className='pointer-events-none absolute -inset-y-1 w-px bg-active-border' style={{ left: timelineInsertMarkerFrame(document, gesture.clipId, preview?.startFrame ?? 0) * pixelsPerFrame }} />}
              {showGhost && preview?.snapFrame !== null && preview !== null && <div className='pointer-events-none absolute -inset-y-1 w-px bg-status-warning-foreground' style={{ left: (preview.snapFrame ?? 0) * pixelsPerFrame }} />}
              <div className='pointer-events-none absolute inset-y-0 w-px bg-foreground' style={playheadStyle} />
            </div>
          </DropRow>;
        })}
      </div>
    </ScrollArea>
  </DndContext>;
}
