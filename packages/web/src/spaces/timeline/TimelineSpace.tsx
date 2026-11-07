// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type * as Y from 'yjs';
import { ArrowRightToLine, Copy, Film, Link2, Magnet, Pause, Play, Plus, Redo2, Scissors, Trash2, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { newId, TIMELINE_MAIN_TRACK_ID, type TimelineClip, type TimelineDocumentV1 } from '@breatic/shared';
import { resolveTimelineArrangement, timelineClipSource, type TimelineArrangementReason } from '@web/data/yjs/timeline-arrangement';
import { removeTimelineClip } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand, TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { activeTimelineClipAt } from '@web/data/yjs/timeline-layers';
import { orderedTimelineClips } from '@web/data/yjs/timeline-order';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { Separator } from '@web/components/ui/separator';
import { Slider } from '@web/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';
import { TIMELINE_MAX_PIXELS_PER_FRAME, TIMELINE_TRACK_HEADER_PX, timelineMinZoom } from '@web/spaces/timeline/timeline-zoom';
import { useExclusiveOverlay } from '@web/features/exclusive-overlay/use-exclusive-overlay';
import { useTranslation } from '@web/i18n/use-translation';
import { isEditableTarget } from '@web/lib/is-editable-target';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import type { SpaceBodyProps } from '@web/spaces';
import { formatShortcut } from '@web/spaces/canvas/format-shortcut';
import { TimelineClipProperties } from '@web/spaces/timeline/TimelineClipProperties';
import { TimelineMaterialDialog } from '@web/spaces/timeline/TimelineMaterialDialog';
import { TimelineTrackArea } from '@web/spaces/timeline/TimelineTrackArea';
import { getTimelineEditSession, type TimelineEditOptions } from '@web/data/yjs/timeline-edit-session';
import { timelineKeyAction } from '@web/spaces/timeline/timeline-keyboard';
import { getTimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { formatTimelineTimecode } from '@web/spaces/timeline/timeline-timecode';
import { useTimelineTrackLabels } from '@web/spaces/timeline/timeline-track-labels';
import { useTimelineDocument } from '@web/spaces/timeline/use-timeline-document';
import { useTimelineEditPrefs } from '@web/spaces/timeline/use-timeline-edit-prefs';
import { useTimelinePlayback } from '@web/spaces/timeline/use-timeline-playback';
import { useTimelineAsset } from '@web/spaces/timeline/use-timeline-asset';

/** The existing content document and its supported native projection. */
interface TimelineEditorProps extends SpaceBodyProps { doc: Y.Doc; document: TimelineDocumentV1; damagedClipIds: readonly string[] }

/** One conflicting placement listed with its frames. */
interface TimelineConflictRowProps {
  projectId: string;
  clip: TimelineClip;
  assetId: string;
  track: string;
  reason: TimelineArrangementReason['code'] | null;
  selected: boolean;
  onLocate: (clipId: string) => void;
}

/** A clip record that can no longer be read, listed so an Editor can delete it. */
interface TimelineDamagedRowProps { clipId: string; readOnly: boolean; onDelete: (clipId: string) => void }

/**
 * List one damaged clip record with its reason and, for an Editor, a delete control.
 * @param props - The record and the delete callback.
 * @param props.clipId - The damaged record's id.
 * @param props.readOnly - Whether editing is unavailable.
 * @param props.onDelete - Deletes the record.
 * @returns The row.
 * @throws {never} Never.
 */
function TimelineDamagedRow({ clipId, readOnly, onDelete }: TimelineDamagedRowProps): React.JSX.Element {
  const t = useTranslation();
  const remove = React.useCallback((): void => onDelete(clipId), [onDelete, clipId]);
  return <div data-testid={`timeline-conflict-${clipId}`} className='flex w-full min-w-0 items-center gap-2 rounded-chrome border border-status-error-border bg-status-error-bg px-2 py-2 text-xs'>
    <Film className='size-4 shrink-0' />
    <span className='min-w-0 flex-1 truncate leading-normal text-status-error-foreground'>{t('timeline.conflictReason.damaged')}</span>
    {!readOnly && <Button data-testid={`timeline-damaged-delete-${clipId}`} variant='outline' size='compact' onClick={remove} icon={<Trash2 className='size-3.5' />}>{t('timeline.edit.delete')}</Button>}
  </div>;
}

const DEFAULT_PIXELS_PER_FRAME = 2;
const LOCATE_MARGIN_PX = 24;
// The zoom slider moves in powers of two so every zoom level is equally reachable.
const ZOOM_STEP = 0.1;

/**
 * List one conflicting placement; pressing it selects it and brings it into view.
 * @param props - The placement and its selection.
 * @param props.projectId - The Project authorizing its source.
 * @param props.clip - The placement.
 * @param props.assetId - Its registered asset.
 * @param props.track - Its track's name.
 * @param props.reason - The first reason it conflicts.
 * @param props.selected - Whether it is selected.
 * @param props.onLocate - Selects it, seeks to it and scrolls the tracks to it.
 * @returns The conflict row.
 * @throws {never} Never.
 */
function TimelineConflictRow({ projectId, clip, assetId, track, reason, selected, onLocate }: TimelineConflictRowProps): React.JSX.Element {
  const t = useTranslation();
  const asset = useTimelineAsset(projectId, assetId);
  const name = asset.data?.displayName || t('timeline.video');
  const locate = React.useCallback((): void => onLocate(clip.id), [onLocate, clip.id]);
  return <Button data-testid={`timeline-conflict-${clip.id}`} type='button' variant={null} size={null} aria-pressed={selected} onClick={locate}
    className={cn('flex w-full min-w-0 flex-col items-start gap-0.5 overflow-hidden rounded-chrome border border-status-error-border bg-status-error-bg px-2 py-1.5 text-left text-xs hover-enabled:border-status-error', selected && 'border-active-border')}>
    <span className='flex w-full min-w-0 items-center gap-2'>
      <Film className='size-4 shrink-0' />
      <Tooltip>
        <TooltipTrigger asChild><span className='min-w-0 truncate leading-normal'>{name}</span></TooltipTrigger>
        <TooltipContent portal className='max-w-sm break-all'>{name}</TooltipContent>
      </Tooltip>
    </span>
    {reason !== null && <span data-testid={`timeline-reason-${clip.id}`} className='w-full truncate text-status-error-foreground'>{t(`timeline.conflictReason.${reason}`)}</span>}
    <span className='w-full tabular-nums text-muted-foreground'>{`${track} · ${t('timeline.clipFrames', { start: clip.startFrame, duration: clip.durationFrames })}`}</span>
  </Button>;
}

/**
 * A toolbar button's shortcut, in the type the menus use for theirs.
 * @param props - The shortcut.
 * @param props.children - The shortcut label.
 * @returns The shortcut.
 * @throws {never} Never.
 */
function ToolbarShortcut({ children }: { children: string }): React.JSX.Element {
  return <kbd className='font-sans text-xs tracking-widest text-muted-foreground'>{children}</kbd>;
}

/** One of the editing switches. */
interface TimelineSwitchProps { testId: string; label: string; shortcut?: string; pressed: boolean; icon: React.ReactElement<{ className?: string }>; onToggle: () => void }

/**
 * An editing switch drawn as an icon button whose tooltip names it and its shortcut.
 * @param props - The switch.
 * @param props.testId - Its test id.
 * @param props.label - Its name.
 * @param props.shortcut - Its key, when it has one.
 * @param props.pressed - Whether it is on.
 * @param props.icon - Its icon.
 * @param props.onToggle - Turns it on or off.
 * @returns The switch.
 * @throws {never} Never.
 */
function TimelineSwitch({ testId, label, shortcut, pressed, icon, onToggle }: TimelineSwitchProps): React.JSX.Element {
  return <Tooltip>
    <TooltipTrigger asChild>
      <Button data-testid={testId} variant='outline' size='sm' aria-label={label} aria-pressed={pressed} onClick={onToggle} icon={icon}
        className='px-2 aria-pressed:border-active-border aria-pressed:bg-accent-strong aria-pressed:hover-enabled:bg-accent-strong' />
    </TooltipTrigger>
    <TooltipContent className='flex items-center gap-2'>{label}{shortcut !== undefined && <span className='tracking-widest text-muted-foreground'>{shortcut}</span>}</TooltipContent>
  </Tooltip>;
}
const PANEL = 'flex flex-col gap-2 rounded-chrome border border-border p-3 text-xs';
const MAGNET_ICON = <Magnet className='size-4' />;
const SNAP_ICON = <ArrowRightToLine className='size-4' />;
const LINKAGE_ICON = <Link2 className='size-4' />;

/**
 * Arrange registered videos on tracks, edit them and preview the shared integer-frame sequence.
 * @param props - The open Timeline's supported content and current role.
 * @param props.projectId - The owning Project.
 * @param props.spaceId - The open Space tab's identity.
 * @param props.readOnly - The existing Project role's editing restriction.
 * @param props.doc - The content document held by the existing Space connection.
 * @param props.document - Its validated native Timeline projection.
 * @param props.damagedClipIds - Clip records that can no longer be read.
 * @returns The preview, toolbar, tracks, properties and conflicts.
 * @throws {never} Never.
 */
function TimelineEditor({ projectId, spaceId, readOnly = false, doc, document, damagedClipIds }: TimelineEditorProps): React.JSX.Element {
  const t = useTranslation();
  const [frame, setFrame] = React.useState(0);
  const [zoom, setZoom] = React.useState(DEFAULT_PIXELS_PER_FRAME);
  const [trackWidth, setTrackWidth] = React.useState(0);
  const name = docName.timelineSpace(projectId, spaceId);
  const session = React.useMemo(() => getTimelineEditSession(doc, name), [doc, name]);
  const history = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const prefs = useTimelineEditPrefs();
  const placement = React.useMemo(() => ({ magnet: prefs.magnet, linkage: prefs.linkage }), [prefs.magnet, prefs.linkage]);
  const labels = useTimelineTrackLabels(document);
  const queryClient = useQueryClient();
  // Every edit, including one placed from the Add media dialog, says when linkage moved clips to a track above.
  const editWithNotice = React.useCallback((command: TimelineEditCommand, options?: TimelineEditOptions): TimelineEditPlan => {
    const plan = session.edit(command, options);
    if (plan.ok && plan.bumped.length > 0) toast.info(t('timeline.edit.bumped', { count: plan.bumped.length }));
    return plan;
  }, [session, t]);
  const material = React.useMemo(() => getTimelineMediaDraft(doc, name, { projectId, spaceId, queryClient, edit: editWithNotice }), [doc, name, projectId, spaceId, queryClient, editWithNotice]);
  const materialState = React.useSyncExternalStore(material.subscribe, material.getSnapshot);
  const [materialOpen, setMaterialOpen] = useExclusiveOverlay(`timeline-material:${projectId}:${spaceId}`);
  // Activity suspends effects while hidden; uploads read the current rendered role.
  material.setCanWrite(!readOnly);
  session.setCanWrite(!readOnly);
  React.useEffect(() => {
    if (!materialState.open && materialOpen) setMaterialOpen(false);
    if (materialState.open && !materialOpen) material.close();
  }, [materialState.open, materialOpen, setMaterialOpen, material]);
  const [media, setMedia] = React.useState<HTMLVideoElement | null>(null);
  const clips = React.useMemo(() => orderedTimelineClips(document.clips), [document.clips]);
  const arrangement = React.useMemo(() => resolveTimelineArrangement(document), [document]);
  const readyIds = React.useMemo(() => new Set(arrangement.readyClipIds), [arrangement.readyClipIds]);
  const reasons = React.useMemo(() => new Map(arrangement.conflicts.map((placement) => [placement.clipId, placement.reasons[0]?.code ?? null])), [arrangement.conflicts]);
  const selectedId = history.selectedClipId;
  const selected = selectedId === null ? undefined : document.clips[selectedId];
  const selectedAssetId = selected === undefined ? '' : timelineClipSource(document.sources, selected)?.assetId ?? '';
  const selectedResource = useTimelineAsset(projectId, selectedAssetId);
  const active = activeTimelineClipAt(document, readyIds, frame);
  const source = active === null ? null : document.sources[active.sourceId] ?? null;
  const assetId = source?.assetId ?? '';
  const resource = useTimelineAsset(projectId, assetId);
  const resourceState = source === null ? 'ready' : resource.isError ? 'failed' : resource.isPending ? 'loading' : 'ready';
  const playback = useTimelinePlayback({ document, readyClipIds: readyIds, frame, onFrame: setFrame, clip: active, source, media, enabled: true, resourceState });
  const { seek, retry: retryPlayback } = playback;
  const { refetch: refetchResource } = resource;
  const duration = Math.max(0, ...clips.map((clip) => clip.startFrame + clip.durationFrames));
  const fps = document.settings.fps;
  const extent = Math.max(duration, Math.ceil(fps.num / fps.den * 12)) + Math.ceil(fps.num / fps.den * 2);
  const seekValue = React.useMemo(() => [Math.min(frame, Math.max(0, duration - 1))], [frame, duration]);
  const onSeek = React.useCallback((value: number[]): void => seek(value[0] ?? 0), [seek]);
  const seekTo = React.useCallback((target: number): void => seek(Math.max(0, Math.min(target, Math.max(0, duration - 1)))), [seek, duration]);
  const selectClip = React.useCallback((clipId: string | null): void => session.select(clipId), [session]);
  const trackViewport = React.useRef<HTMLDivElement>(null);

  const commit = React.useCallback((command: TimelineEditCommand, options?: TimelineEditOptions): TimelineEditPlan | null => {
    if (readOnly) return null;
    const plan = editWithNotice(command, options);
    if (!plan.ok) toast.warning(t(`timeline.errors.${plan.reason}`));
    return plan;
  }, [readOnly, editWithNotice, t]);
  const removeDamaged = React.useCallback((clipId: string): void => { if (!readOnly) removeTimelineClip(doc, clipId, session.origin); }, [readOnly, doc, session]);
  const commitCommand = React.useCallback((command: TimelineEditCommand): void => { commit(command); }, [commit]);
  const vanished = React.useCallback((): void => { toast.warning(t('timeline.errors.clip_removed')); }, [t]);

  const needSelection = React.useCallback((): TimelineClip | null => {
    if (selected === undefined) { toast.warning(t('timeline.edit.selectFirst')); return null; }
    return selected;
  }, [selected, t]);
  const split = React.useCallback((): void => {
    const clip = needSelection();
    if (clip === null) return;
    if (!(clip.startFrame < frame && frame < clip.startFrame + clip.durationFrames)) { toast.warning(t('timeline.edit.splitOutside')); return; }
    commit({ operation: 'split', parameters: { clipId: clip.id, frame, newClipId: newId() }, placement });
  }, [needSelection, frame, commit, placement, t]);
  const duplicate = React.useCallback((): void => {
    const clip = needSelection();
    if (clip === null) return;
    const copyId = newId();
    if (commit({ operation: 'duplicate', parameters: { clipId: clip.id, newClipId: copyId }, placement })?.ok === true) session.select(copyId);
  }, [needSelection, commit, placement, session]);
  const remove = React.useCallback((): void => {
    const clip = needSelection();
    if (clip !== null) commit({ operation: 'delete', parameters: { clipId: clip.id }, placement });
  }, [needSelection, commit, placement]);
  const undo = React.useCallback((): void => { if (!readOnly) session.undo(); }, [readOnly, session]);
  const redo = React.useCallback((): void => { if (!readOnly) session.redo(); }, [readOnly, session]);
  const toggleMagnet = React.useCallback((): void => prefs.set({ magnet: !prefs.magnet }), [prefs]);
  const toggleSnap = React.useCallback((): void => prefs.set({ snap: !prefs.snap }), [prefs]);
  const toggleLinkage = React.useCallback((): void => prefs.set({ linkage: !prefs.linkage }), [prefs]);
  const minZoom = timelineMinZoom(extent, trackWidth);
  const pixelsPerFrame = Math.min(TIMELINE_MAX_PIXELS_PER_FRAME, Math.max(minZoom, zoom));
  const zoomValue = React.useMemo(() => [Math.log2(pixelsPerFrame)], [pixelsPerFrame]);
  const changeZoom = React.useCallback((value: number[]): void => setZoom(2 ** (value[0] ?? Math.log2(DEFAULT_PIXELS_PER_FRAME))), []);
  const locateClip = React.useCallback((clipId: string): void => {
    session.select(clipId);
    const clip = document.clips[clipId];
    if (clip === undefined) return;
    seekTo(clip.startFrame);
    const viewport = trackViewport.current;
    const left = clip.startFrame * pixelsPerFrame;
    // The lanes visible right of the sticky track headers; the margin keeps the start off the headers' edge.
    if (viewport !== null && (left < viewport.scrollLeft || left >= viewport.scrollLeft + viewport.clientWidth - TIMELINE_TRACK_HEADER_PX)) viewport.scrollTo({ left: Math.max(0, left - LOCATE_MARGIN_PX) });
  }, [session, document.clips, seekTo, pixelsPerFrame]);

  const nudge = React.useCallback((frames: number): void => {
    if (readOnly || selected === undefined) { seekTo(frame + frames); return; }
    if (selected.trackId === TIMELINE_MAIN_TRACK_ID && placement.magnet) {
      const sequence = clips.filter((clip) => clip.trackId === TIMELINE_MAIN_TRACK_ID);
      const index = sequence.findIndex((clip) => clip.id === selected.id);
      const neighbour = sequence[index + (frames > 0 ? 1 : -1)];
      if (neighbour === undefined) return;
      commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: frames > 0 ? neighbour.startFrame + neighbour.durationFrames : neighbour.startFrame }, placement }, { hold: true });
      return;
    }
    commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: Math.max(0, selected.startFrame + frames) }, placement }, { hold: true });
  }, [readOnly, selected, seekTo, frame, placement, clips, commit]);
  const changeTrack = React.useCallback((direction: 1 | -1, repeat: boolean): void => {
    if (readOnly || selected === undefined) return;
    const index = labels.visual.findIndex((track) => track.id === selected.trackId);
    if (index < 0) { toast.warning(t('timeline.errors.track_missing')); return; }
    const target = labels.visual[index + direction];
    if (target !== undefined) { commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: selected.startFrame, trackId: target.id }, placement }, { hold: true }); return; }
    // A held key stops at the top track; only a fresh press creates a track above it.
    if (repeat) return;
    if (direction === 1) commit({ operation: 'move', parameters: { clipId: selected.id, startFrame: selected.startFrame, newTrackId: newId() }, placement });
    else toast.warning(t('timeline.edit.lowestTrack'));
  }, [readOnly, selected, labels.visual, commit, placement, t]);

  const trackDragging = React.useRef(false);
  const draggingChange = React.useCallback((value: boolean): void => { trackDragging.current = value; }, []);
  const onKeyDown = React.useCallback((event: KeyboardEvent): void => {
    // A fresh press, whatever it does, ends the key hold so a later repeat cannot join the old step.
    if (!event.repeat) session.endHold();
    // Text fields and Select triggers answer their own keys (a trigger's typeahead does not mark them handled).
    if (!regionOwnsKeyboard(event.target, 'space') || (event.target instanceof Element && (isEditableTarget(event.target) || event.target.closest('[role="combobox"]') !== null))) return;
    const action = timelineKeyAction(event, fps);
    if (action === null) return;
    const editing = action.kind !== 'nudge' && action.kind !== 'toggle_snap';
    if (editing && readOnly) return;
    event.preventDefault();
    // A drag writes once, on release; only the snap switch changes while it is held.
    if (trackDragging.current && action.kind !== 'toggle_snap') return;
    switch (action.kind) {
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'duplicate': duplicate(); break;
      case 'split': split(); break;
      case 'delete': remove(); break;
      case 'toggle_snap': toggleSnap(); break;
      case 'nudge': nudge(action.frames); break;
      case 'change_track': changeTrack(action.direction, action.repeat); break;
    }
  }, [session, fps, readOnly, undo, redo, duplicate, split, remove, toggleSnap, nudge, changeTrack]);
  const root = React.useRef<HTMLDivElement>(null);
  const editorColumn = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const element = editorColumn.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setTrackWidth(Math.max(0, element.clientWidth - TIMELINE_TRACK_HEADER_PX)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The element of this Timeline holding keyboard focus. A clip moved to another track row remounts there, and a
  // deleted clip, track or list row is gone; either way the browser drops focus to <body>, so it is handed back to
  // the clip, or to the Timeline.
  const focused = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    const element = root.current;
    if (element === null) return;
    /**
     * Remember the focused element.
     * @param event - The focus event.
     * @throws {never} Never.
     */
    const focusIn = (event: FocusEvent): void => {
      focused.current = event.target instanceof HTMLElement ? event.target : null;
    };
    /**
     * Forget the element when focus leaves it while it is still on the page: the user moved focus away.
     * @param event - The focus event.
     * @throws {never} Never.
     */
    const focusOut = (event: FocusEvent): void => {
      const target = event.target;
      if (target !== focused.current) return;
      queueMicrotask(() => { if (target instanceof HTMLElement && target.isConnected && focused.current === target) focused.current = null; });
    };
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    return () => {
      element.removeEventListener('focusin', focusIn);
      element.removeEventListener('focusout', focusOut);
    };
  }, []);
  React.useLayoutEffect(() => {
    const element = focused.current;
    if (element === null) return;
    if (element.isConnected) {
      if (window.document.activeElement !== element) focused.current = null;
      return;
    }
    focused.current = null;
    if (window.document.activeElement !== window.document.body) return;
    const clipId = element.dataset.clipId;
    const clip = clipId === undefined ? null : root.current?.querySelector<HTMLElement>(`[data-clip-id="${CSS.escape(clipId)}"]`);
    (clip ?? root.current)?.focus();
  });
  const keyHandler = React.useRef(onKeyDown);
  keyHandler.current = onKeyDown;
  React.useEffect(() => {
    // Listening on window runs after React's root listener, so a focused control (slider, select) has
    // already handled and marked the key. Keys reach the handler from inside this Space body, or from
    // <body> after the focused element was removed; hidden Spaces have no listener (Activity removes effects).
    /**
     * Forward a key press inside this Timeline to the current handler.
     * @param event - The key press.
     * @throws {never} Never.
     */
    const listener = (event: KeyboardEvent): void => {
      if (event.target === window.document.body || (event.target instanceof Node && root.current?.contains(event.target) === true)) keyHandler.current(event);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const openMaterial = React.useCallback((): void => {
    if (readOnly) return;
    material.open(duration, selected !== undefined && labels.nameOf(selected.trackId) !== null ? selected.trackId : TIMELINE_MAIN_TRACK_ID);
    setMaterialOpen(true);
  }, [readOnly, duration, material, setMaterialOpen, selected, labels]);
  const closeMaterial = React.useCallback((): void => { material.close(); setMaterialOpen(false); }, [material, setMaterialOpen]);
  const retryPreview = React.useCallback((): void => { void refetchResource(); retryPlayback(); }, [refetchResource, retryPlayback]);
  const previewStyle = React.useMemo(() => ({ aspectRatio: `${document.settings.width} / ${document.settings.height}` }), [document.settings.width, document.settings.height]);
  const inConflict = clips.some((clip) => !readyIds.has(clip.id) && frame >= clip.startFrame && frame < clip.startFrame + clip.durationFrames);
  const noSelection = selected === undefined;
  const hasConflicts = arrangement.hasConflicts || damagedClipIds.length > 0;
  // Click-focusable, not tab-reachable: where the keyboard goes when the focused element leaves the page.
  return <div ref={root} data-testid='timeline-space' data-project-id={projectId} data-space-id={spaceId} tabIndex={-1} data-space-focus-root='' className='flex h-full min-h-0 min-w-0 bg-background outline-none'>
    {/* The tracks take their content's height up to half the column; the preview takes the rest. */}
    <div ref={editorColumn} className='grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto_auto_fit-content(50%)]'>
      <div className='flex min-h-0 flex-1 items-center justify-center bg-muted/40 p-6'>
        <div data-testid='timeline-preview' data-active-clip-id={active?.id ?? ''} className='relative flex max-h-full w-full max-w-4xl items-center justify-center overflow-hidden rounded-content-sm border border-border bg-background' style={previewStyle}>
          {source !== null && resource.data !== undefined && !resource.isError && (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- user-uploaded asset; no caption track until caption authoring lands.
            <video key={`${source.id}:${assetId}:${resource.data.fileUrl}`} ref={setMedia} src={resource.data.fileUrl} poster={resource.data.coverUrl ?? undefined} preload='auto' playsInline className='absolute inset-0 h-full w-full object-contain' />
          )}
          {clips.length === 0 && <div data-testid='timeline-space-empty' className='flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground'><Film className='size-8' /><p>{t('timeline.empty')}</p></div>}
          {inConflict && active === null && <p className='p-6 text-center text-sm text-status-error-foreground'>{t('timeline.conflictHelp')}</p>}
          {source !== null && resource.isPending && <p className='p-6 text-sm text-muted-foreground'>{t('timeline.loadingMedia')}</p>}
          {(resource.isError || playback.state === 'failed') && source !== null && <div className='relative flex flex-col items-center gap-3 p-6 text-sm'><p>{t('timeline.mediaUnavailable')}</p><Button variant='outline' onClick={retryPreview}>{t('timeline.retry')}</Button></div>}
        </div>
      </div>
      <div className='flex shrink-0 items-center gap-3 border-t border-border px-4 py-2'>
        <Button data-testid='timeline-play' variant='outline' size='sm' className='gap-1.5' disabled={duration === 0} onClick={playback.toggle} icon={playback.intent === 'play' ? <Pause className='size-4' /> : <Play className='size-4' />}>{playback.intent === 'play' ? t('timeline.pause') : t('timeline.play')}</Button>
        <span className='shrink-0 text-xs tabular-nums'>{`${formatTimelineTimecode(frame, fps)} / ${formatTimelineTimecode(duration, fps)}`}</span>
        <Slider aria-label={t('timeline.seek')} value={seekValue} onValueChange={onSeek} min={0} max={Math.max(1, duration - 1)} step={1} disabled={duration === 0} className='min-w-0 flex-1' />
        <span className='shrink-0 text-xs text-muted-foreground'>{t(`timeline.transport.${playback.state}`)}</span>
      </div>
      <div role='toolbar' aria-label={t('timeline.tracks')} className='flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <Button data-testid='timeline-add-media' variant='outline' size='sm' className='gap-1.5' disabled={readOnly} onClick={openMaterial} icon={<Plus className='size-4' />}>{t('timeline.addMedia')}</Button>
          <Button data-testid='timeline-undo' variant='outline' size='sm' className='gap-1.5' disabled={readOnly || !history.canUndo} onClick={undo} icon={<Undo2 className='size-4' />}>{t('timeline.edit.undo')}</Button>
          <Button data-testid='timeline-redo' variant='outline' size='sm' className='gap-1.5' disabled={readOnly || !history.canRedo} onClick={redo} icon={<Redo2 className='size-4' />}>{t('timeline.edit.redo')}</Button>
          <Separator orientation='vertical' className='h-5' />
          <Button data-testid='timeline-split' variant='outline' size='sm' disabled={readOnly} aria-disabled={noSelection} className={cn('gap-1.5', noSelection && 'opacity-50')} onClick={split} icon={<Scissors className='size-4' />}>{t('timeline.edit.split')}<ToolbarShortcut>{formatShortcut({ mod: true, key: 'B' })}</ToolbarShortcut></Button>
          <Button data-testid='timeline-duplicate' variant='outline' size='sm' disabled={readOnly} aria-disabled={noSelection} className={cn('gap-1.5', noSelection && 'opacity-50')} onClick={duplicate} icon={<Copy className='size-4' />}>{t('timeline.edit.duplicate')}<ToolbarShortcut>{formatShortcut({ mod: true, key: 'D' })}</ToolbarShortcut></Button>
          <Button data-testid='timeline-delete' variant='outline' size='sm' disabled={readOnly} aria-disabled={noSelection} className={cn('gap-1.5', noSelection && 'opacity-50')} onClick={remove} icon={<Trash2 className='size-4' />}>{t('timeline.edit.delete')}<ToolbarShortcut>{formatShortcut({ key: 'Delete' })}</ToolbarShortcut></Button>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <TimelineSwitch testId='timeline-toggle-magnet' label={t('timeline.edit.magnet')} pressed={prefs.magnet} icon={MAGNET_ICON} onToggle={toggleMagnet} />
          <TimelineSwitch testId='timeline-toggle-snap' label={t('timeline.edit.snap')} shortcut='N' pressed={prefs.snap} icon={SNAP_ICON} onToggle={toggleSnap} />
          <TimelineSwitch testId='timeline-toggle-linkage' label={t('timeline.edit.linkage')} pressed={prefs.linkage} icon={LINKAGE_ICON} onToggle={toggleLinkage} />
          <span className='flex items-center gap-2'>
            <span className='text-xs text-muted-foreground'>{t('timeline.edit.zoom')}</span>
            <Slider data-testid='timeline-zoom' aria-label={t('timeline.edit.zoom')} value={zoomValue} onValueChange={changeZoom} min={Math.log2(minZoom)} max={Math.log2(TIMELINE_MAX_PIXELS_PER_FRAME)} step={ZOOM_STEP} className='w-28' />
          </span>
        </div>
      </div>
      <TimelineTrackArea projectId={projectId} document={document} labels={labels} readyIds={readyIds} selectedId={selectedId} frame={frame} extent={extent} viewportRef={trackViewport}
        pixelsPerFrame={pixelsPerFrame} readOnly={readOnly} snap={prefs.snap} placement={placement} onSelect={selectClip} onSeek={seekTo} onCommit={commitCommand} onVanished={vanished} onDraggingChange={draggingChange} />
    </div>
    <aside data-testid='timeline-side-panel' className='flex w-72 shrink-0 flex-col border-l border-border'>
      <ScrollArea className='min-h-0 flex-1' viewportClassName='p-3'>
        <div className='flex flex-col gap-3'>
          <section className={PANEL}>
            {selected === undefined ? <p className='text-muted-foreground'>{t('timeline.selectClip')}</p>
              : <TimelineClipProperties key={selected.id} spaceId={spaceId} document={document} clip={selected} conflict={!readyIds.has(selected.id)} reason={reasons.get(selected.id) ?? null} labels={labels} readOnly={readOnly} placement={placement} onCommit={commitCommand}
                name={selectedResource.data?.displayName || t(selectedResource.isError ? 'timeline.mediaUnavailable' : 'timeline.video')} />}
          </section>
          <section data-testid='timeline-conflicts' className={PANEL}>
            <h3 className='text-sm font-semibold'>{t('timeline.conflictList')}</h3>
            {hasConflicts ? <>
              <p className='text-muted-foreground'>{t('timeline.conflictHelp')}</p>
              {clips.filter((clip) => !readyIds.has(clip.id)).map((clip) => <TimelineConflictRow key={clip.id} projectId={projectId} clip={clip} assetId={timelineClipSource(document.sources, clip)?.assetId ?? ''} track={labels.nameOf(clip.trackId) ?? t('timeline.edit.trackRemoved')} reason={reasons.get(clip.id) ?? null} selected={selectedId === clip.id} onLocate={locateClip} />)}
              {damagedClipIds.map((clipId) => <TimelineDamagedRow key={clipId} clipId={clipId} readOnly={readOnly} onDelete={removeDamaged} />)}
            </> : <p className='text-muted-foreground'>{t('timeline.noConflicts')}</p>}
          </section>
        </div>
      </ScrollArea>
    </aside>
    {materialState.open && materialOpen && <TimelineMaterialDialog key={`${projectId}:${spaceId}`} projectId={projectId} spaceId={spaceId} draft={material} canWrite={!readOnly} document={document} placement={placement} onClose={closeMaterial} />}
  </div>;
}

/**
 * Bind Timeline to the document and connection already held by its Space tab.
 * @param props - The current Project, Space and role.
 * @returns The existing content state or the supported Timeline editor.
 * @throws {never} Never.
 */
export function TimelineSpace(props: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const connection = useSpaceConnection();
  const doc = getDoc(docName.timelineSpace(props.projectId, props.spaceId));
  const state = useTimelineDocument(doc, connection.hasEverSynced);
  if (!connection.hasEverSynced) return <div data-testid={connection.status === 'authFailed' ? 'timeline-space-unavailable' : 'timeline-space-loading'} className='flex h-full items-center justify-center p-6 text-sm text-muted-foreground'>{t(connection.status === 'authFailed' ? 'timeline.unavailable' : 'timeline.loading')}</div>;
  if (state.document === null) return <div data-testid='timeline-space-error' className='flex h-full items-center justify-center p-6 text-sm text-muted-foreground'>{t('timeline.incompatible')}</div>;
  return <TimelineEditor {...props} doc={doc} document={state.document} damagedClipIds={state.damaged.clips} />;
}
