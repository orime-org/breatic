// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { Film, Trash2 } from 'lucide-react';
import { newId, TIMELINE_MAIN_TRACK_ID, type TimelineDocumentV1, type TimelineVideoClip } from '@breatic/shared';
import type { TimelineEditCommand, TimelineEditPlacement } from '@web/data/yjs/timeline-edit';
import { orderedTimelineClips, orderedTimelineTracks } from '@web/data/yjs/timeline-order';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { useTranslation } from '@web/i18n/use-translation';
import { cn } from '@web/lib/utils';
import { previewTimelineGesture, timelineGestureCommand, timelineInsertMarkerFrame, type TimelineGestureMode, type TimelineGesturePreview } from '@web/spaces/timeline/timeline-gesture';
import type { TimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';
import { TIMELINE_TRACK_HEADER_PX, timelineRulerStep } from '@web/spaces/timeline/timeline-zoom';
import { useTimelineAsset } from '@web/spaces/timeline/use-timeline-asset';

const DRAG_ACTIVATION_PX = 3;
const HEADER_STYLE = { width: TIMELINE_TRACK_HEADER_PX };

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
  onSelect: (clipId: string | null) => void;
  onSeek: (frame: number) => void;
  onCommit: (command: TimelineEditCommand) => void;
  onVanished: () => void;
  onDraggingChange: (dragging: boolean) => void;
}

/** The active pointer gesture and its latest preview. */
interface Gesture { mode: TimelineGestureMode; clipId: string; preview: TimelineGesturePreview | null }

/** One clip on its track row. */
interface ClipProps {
  projectId: string;
  clip: TimelineVideoClip;
  assetId: string;
  selected: boolean;
  conflict: boolean;
  dragging: boolean;
  readOnly: boolean;
  pixelsPerFrame: number;
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
  return <div ref={setNodeRef} {...listeners} {...attributes} tabIndex={-1} role='presentation' data-testid={`timeline-${mode}-${clipId}`}
    className={cn('absolute inset-y-0 z-10 w-1.5 cursor-ew-resize bg-active-border', mode === 'trim-start' ? 'left-0 rounded-l-chrome' : 'right-0 rounded-r-chrome')} />;
}

/**
 * One placed clip: click selects, drag moves, the selected clip shows trim handles.
 * @param props - The clip and its state.
 * @param props.projectId - The authorizing Project.
 * @param props.clip - The placement.
 * @param props.assetId - Its registered asset.
 * @param props.selected - Whether it is selected.
 * @param props.conflict - Whether the arrangement reports a conflict.
 * @param props.dragging - Whether a gesture is moving it.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.pixelsPerFrame - The current zoom.
 * @param props.onSelect - Selects the clip.
 * @returns The clip.
 * @throws {never} Never.
 */
const TimelineClip = React.memo(function TimelineClip({ projectId, clip, assetId, selected, conflict, dragging, readOnly, pixelsPerFrame, onSelect }: ClipProps): React.JSX.Element {
  const t = useTranslation();
  const name = useTimelineAsset(projectId, assetId).data?.displayName || null;
  // Only the pointer listeners are used: the clip is already a focusable Button, and dnd-kit's
  // attributes would mark a read-only clip aria-disabled although it stays selectable.
  const { listeners, setNodeRef } = useDraggable({ id: `move:${clip.id}`, data: { mode: 'move', clipId: clip.id }, disabled: readOnly });
  const select = React.useCallback((): void => onSelect(clip.id), [onSelect, clip.id]);
  const style = React.useMemo(() => ({ left: clip.startFrame * pixelsPerFrame, width: Math.max(2, clip.durationFrames * pixelsPerFrame) }), [clip.startFrame, clip.durationFrames, pixelsPerFrame]);
  return <div className={cn('absolute inset-y-1', dragging && 'opacity-40')} style={style}>
    <Button ref={setNodeRef} {...(readOnly ? {} : listeners)} data-testid={`timeline-clip-${clip.id}`} data-clip-id={clip.id} data-track-id={clip.trackId} type='button' variant={null} size={null}
      aria-pressed={selected} onClick={select} onFocus={select}
      className={cn('flex size-full min-w-0 justify-start gap-2 overflow-hidden rounded-chrome border border-border bg-muted px-2 text-xs hover-enabled:bg-accent',
        !readOnly && 'cursor-grab', conflict && 'border-status-error-border bg-status-error-bg', selected && 'border-active-border')}>
      <Film className='size-4 shrink-0' />
      <span className='min-w-0 truncate leading-normal'>{name ?? t('timeline.video')}</span>
      {conflict && <span className='shrink-0 text-status-error-foreground'>{t('timeline.conflict')}</span>}
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
  return <Button data-testid={`timeline-delete-track-${trackId}`} variant='ghost' size='compact' className='ml-auto' onClick={remove} icon={<Trash2 className='size-3.5' />}>{t('timeline.edit.deleteTrack')}</Button>;
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
  return <div ref={setNodeRef} data-testid={testId} className={cn('flex border-b border-border', className, isOver && id === 'new' && 'bg-muted')}>{children}</div>;
}

/** The editor facts a drag preview reads at the moment it is computed. */
interface DragView { document: TimelineDocumentV1; frame: number; pixelsPerFrame: number; snap: boolean; placement: TimelineEditPlacement }

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
    { snap: view.snap, pixelsPerFrame: view.pixelsPerFrame, playhead: view.frame, magnet: view.placement.magnet });
}

/**
 * The ruler, the track rows and their clips, with drag, trim, snap and the new-track zone.
 * @param props - The document view and editing callbacks.
 * @returns The scrollable track area.
 * @throws {never} Never.
 */
export function TimelineTrackArea(props: TimelineTrackAreaProps): React.JSX.Element {
  const { projectId, document, labels, readyIds, selectedId, frame, extent, pixelsPerFrame, readOnly, snap, placement, onSelect, onSeek, onCommit, onVanished, onDraggingChange } = props;
  const t = useTranslation();
  const [gesture, setGesture] = React.useState<Gesture | null>(null);
  const cancelled = React.useRef(false);
  const latest = React.useRef({ document, frame, pixelsPerFrame, snap, placement, readOnly });
  latest.current = { document, frame, pixelsPerFrame, snap, placement, readOnly };
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
  const cancelDrag = React.useCallback((): void => setGesture(null), []);
  React.useEffect(() => {
    if (!readOnly) return;
    cancelled.current = true;
    setGesture(null);
  }, [readOnly]);
  // Leaving the window ends a drag without writing (dnd-kit itself cancels only on Esc, resize and hidden pages).
  const dragging = gesture !== null;
  React.useEffect(() => {
    onDraggingChange(dragging);
    return () => onDraggingChange(false);
  }, [dragging, onDraggingChange]);
  React.useEffect(() => {
    if (!dragging) return;
    /**
     * Cancel the drag in progress.
     * @throws {never} Never.
     */
    const cancel = (): void => { cancelled.current = true; setGesture(null); };
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [dragging]);

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
  const header = 'sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-border bg-background px-2 text-xs';

  return <DndContext sensors={sensors} onDragStart={startDrag} onDragMove={moveDrag} onDragEnd={endDrag} onDragCancel={cancelDrag} autoScroll={false}>
    <ScrollArea scrollbars='both' className='h-48 shrink-0 border-t border-border'>
      <div style={{ width: width + TIMELINE_TRACK_HEADER_PX }} className='relative min-w-full'>
        <div className='sticky top-0 z-30 flex h-6 border-b border-border bg-background'>
          <div className={header} style={HEADER_STYLE} />
          <div data-testid='timeline-ruler' className='relative flex-1 cursor-pointer' onPointerDown={seekFromRuler}>
            {Array.from({ length: Math.floor(seconds / labelStep) + 1 }, (_, index) => index * labelStep).map((second) => <span key={second} className='absolute inset-y-0 border-l border-border pl-1 text-2xs tabular-nums text-muted-foreground' style={{ left: second * fps * pixelsPerFrame }}>{second}s</span>)}
          </div>
        </div>
        {!readOnly && <DropRow id='new' testId='timeline-new-track-zone' className='h-7 border-dashed'>
          <div className={header} style={HEADER_STYLE} />
          <div className='flex flex-1 items-center px-2 text-2xs text-muted-foreground'>{gesture?.mode === 'move' ? t('timeline.edit.newTrackZone') : null}</div>
        </DropRow>}
        {rows.map((track) => {
          const clips = orderedTimelineClips(document.clips, track.id);
          const isMain = track.id === TIMELINE_MAIN_TRACK_ID;
          const showGhost = preview !== null && (preview.trackId ?? '') === track.id;
          return <DropRow key={track.id} id={track.id} testId={`timeline-track-${track.id}`} className={isMain ? 'h-16' : 'h-12'}>
            <div className={header} style={HEADER_STYLE}>
              <span className='min-w-0 truncate'>{labels.nameOf(track.id) ?? track.id}</span>
              {isMain && <span className='rounded-chrome border border-border px-1 text-2xs text-muted-foreground'>{placement.magnet ? t('timeline.edit.magnetOn') : t('timeline.edit.magnetOff')}</span>}
              {!isMain && !readOnly && clips.length === 0 && <DeleteTrackButton trackId={track.id} placement={placement} onCommit={onCommit} />}
            </div>
            <div data-testid={`timeline-lane-${track.id}`} className='relative flex-1' onPointerDown={clearOnBlank}>
              {clips.map((clip) => <TimelineClip key={clip.id} projectId={projectId} clip={clip} assetId={document.sources[clip.sourceId]?.assetId ?? ''}
                selected={selectedId === clip.id} conflict={!readyIds.has(clip.id)} dragging={gesture?.clipId === clip.id && preview !== null}
                readOnly={readOnly} pixelsPerFrame={pixelsPerFrame} onSelect={onSelect} />)}
              {showGhost && preview !== null && <div className='pointer-events-none absolute inset-y-1 rounded-chrome border border-active-border bg-muted/60' style={ghostStyle}>
                <span data-testid='timeline-ghost-label' className='absolute -top-5 left-0 whitespace-nowrap rounded-chrome border border-border bg-background px-1 text-2xs tabular-nums'>
                  {t('timeline.clipFrames', { start: preview.startFrame, duration: preview.durationFrames })}
                  {gesture?.mode === 'move' && ` · ${t(isMain && placement.magnet ? 'timeline.edit.ghostInsert' : 'timeline.edit.ghostOverwrite')}`}
                </span>
              </div>}
              {showGhost && isMain && placement.magnet && gesture?.mode === 'move' && <div data-testid='timeline-insert-marker' className='pointer-events-none absolute -inset-y-1 w-px bg-active-border' style={{ left: timelineInsertMarkerFrame(document, gesture.clipId, preview?.startFrame ?? 0) * pixelsPerFrame }} />}
              {showGhost && preview?.snapFrame !== null && preview !== null && <div className='pointer-events-none absolute -inset-y-1 w-px bg-status-warning-foreground' style={{ left: (preview.snapFrame ?? 0) * pixelsPerFrame }} />}
              <div className='pointer-events-none absolute inset-y-0 w-px bg-active-border' style={{ left: frame * pixelsPerFrame }} />
            </div>
          </DropRow>;
        })}
      </div>
    </ScrollArea>
  </DndContext>;
}
