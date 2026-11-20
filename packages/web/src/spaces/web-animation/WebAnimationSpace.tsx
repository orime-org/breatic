// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  Check, Download, Ellipsis, LayoutGrid, List, LoaderCircle, MessageSquare,
  MessageSquarePlus, Pause, Pencil, Play, Plus, Undo2, Upload, Video,
} from 'lucide-react';
import { formatCredits, getLocale, newId } from '@breatic/shared';
import { anchorTimeWithin, readWebAnimationAnchor, type WebAnimationRowView } from '@breatic/shared/space-content';

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Separator } from '@web/components/ui/separator';
import { Slider } from '@web/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { spaceTasksQueryKey } from '@web/data/api/scene';
import { useSceneControls } from '@web/data/api/use-scene-controls';
import { refusalSentence, serverMessage } from '@web/data/api/server-message';
import { timelineApi, type WebAnimationAcceptBody, type WebAnimationAcceptRequest } from '@web/data/api/timeline';
import { useProjectSpaceList, type ProjectSpace } from '@web/data/yjs/project-meta';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { useTranslation } from '@web/i18n/use-translation';
import { downloadAsset } from '@web/lib/download';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import type { SpaceBodyProps } from '@web/spaces';
import { canvasOrigin, canvasesOldestFirst } from '@web/spaces/canvas/place-on-canvas';
import { placeVideoOnCanvas } from '@web/spaces/canvas/place-video-on-canvas';
import { DocumentCommentWriteBox } from '@web/spaces/document/DocumentCommentWriteBox';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { SpaceFullError } from '@web/spaces/document/document-comment-thread-store';
import { useTimelineAsset } from '@web/spaces/timeline/use-timeline-asset';
import { useTimelineLimitsQuery } from '@web/spaces/timeline/use-timeline-limits';
import { ANNOTATION_DRAFT_IDLE, transitionAnnotationDraft, type AnnotationDraftEvent, type FramePoint } from '@web/spaces/web-animation/annotation-draft';
import { threadSummary } from '@web/spaces/web-animation/annotation-groups';
import { webAnimationAnnotationStore } from '@web/spaces/web-animation/annotation-thread-store';
import { CREATION_DRAFT_CLOSED, transitionCreationDraft, type CreationDraftInput } from '@web/spaces/web-animation/creation-draft';
import { DEFAULT_WEB_ANIMATION_ENGINE, cancelIntent, exportIntent, executionStepKeys, isWebAnimationAspect } from '@web/spaces/web-animation/execution-text';
import { MOTION_PANELS_CLOSED, transitionMotionPanels, type MotionTab } from '@web/spaces/web-animation/motion-panels';
import { ListLoadError, listShows } from '@web/spaces/web-animation/list-states';
import { BarButton, PreviewUnavailable, formatMotionTime, playable, rowSeconds } from '@web/spaces/web-animation/motion-parts';
import { requestTitle, webAnimationTitle } from '@web/spaces/web-animation/web-animation-title';
import { MotionAnnotationsPanel } from '@web/spaces/web-animation/MotionAnnotationsPanel';
import { MotionExecutionsPanel } from '@web/spaces/web-animation/MotionExecutionsPanel';
import { MotionResultPlayer } from '@web/spaces/web-animation/MotionResultPlayer';
import { MotionFrameCard } from '@web/spaces/web-animation/MotionFrameCard';
import { MotionThreadCard } from '@web/spaces/web-animation/MotionThreadCard';
import { useMotionAnnotations, useThreads } from '@web/spaces/web-animation/use-motion-annotations';
import { useMotionClock } from '@web/spaces/web-animation/use-motion-clock';
import { rowsOf, useMotionLists } from '@web/spaces/web-animation/use-motion-lists';
import { WebAnimationDialog } from '@web/spaces/web-animation/WebAnimationDialog';
import { SELECTION_NONE, shown, transitionWebAnimationSelection, type SelectionEvent, type SelectionState } from '@web/spaces/web-animation/web-animation-selection';
import { useCurrentUserStore } from '@web/stores';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';
import { getRunning, runOnce, useRunning } from '@web/stores/task-actions-in-flight';

/** The bar's icons, made once so a memoized bar button skips the renders the play clock causes. */
const PLACE_ICON = <LayoutGrid className='size-4' />;
const DETAILS_ICON = <Ellipsis className='size-4' />;
const NEW_ICON = <Plus className='size-4' />;
const ADD_ANNOTATION_ICON = <MessageSquarePlus className='size-4' />;
const MODIFY_ICON = <Pencil className='size-4' />;
const VIDEO_ICON = <Video className='size-4' />;
const EXPORT_ICON = <Upload className='size-4' />;
const DOWNLOAD_ICON = <Download className='size-4' />;
const SOURCE_ICON = <Undo2 className='size-4' />;
const EXECUTIONS_ICON = <List className='size-4' />;
const ANNOTATIONS_ICON = <MessageSquare className='size-4' />;
const PLAY_ICON = <Play className='size-4' />;
const PAUSE_ICON = <Pause className='size-4' />;
/** How close to the playhead an annotation's point shows on the frame, in seconds. */
const PIN_WINDOW_SECONDS = 0.15;
/**
 * How far a menu or popover opened from a bar button stands off it: the 4px visible gap from the bar's edge, plus the 7px between
 * the 32px button and the 48px bar's 1px border, and that border.
 */
const BAR_MENU_OFFSET = 4 + 7 + 1;
/** An annotation's pin on the frame, saved or being written: a 20px drop whose tip, its bottom-left corner, is the point. */
const PIN_CLASS = 'absolute size-5 -translate-y-full rounded-full rounded-bl-none border border-background';

/**
 * The rows read by id, by id.
 * @param results - The reads.
 * @returns Each read that answered.
 * @throws {never} Never.
 */
function rowsRead(results: Array<UseQueryResult<WebAnimationRowView>>): ReadonlyMap<string, WebAnimationRowView> {
  return new Map(results.flatMap((result) => (result.data === undefined ? [] : [[result.data.id, result.data] as const])));
}

/**
 * The frame ratio a row is shown at.
 * @param row - The row.
 * @returns Width over height.
 * @throws {never} Never.
 */
function ratioOf(row: WebAnimationRowView): number {
  if (row.kind === 'web_animation_export') return row.input.width / row.input.height;
  const [width, height] = row.input.aspect.split(':').map(Number) as [number, number];
  return width / height;
}

/** "Put on canvas" for an exported video. */
interface PlaceOnCanvasProps {
  projectId: string;
  row: Extract<WebAnimationRowView, { kind: 'web_animation_export' }>;
  canvases: readonly ProjectSpace[];
}

/**
 * Put an exported video on one of the Project's canvases (#1490 design §9.1, §13.4): a menu of canvases; the button
 * waits from the choice until collab confirms the node.
 * @param props - The export and the canvases.
 * @param props.projectId - The Project.
 * @param props.row - The export.
 * @param props.canvases - The Project's canvases, oldest first.
 * @returns The button.
 * @throws {never} Never.
 */
function PlaceOnCanvas({ projectId, row, canvases }: PlaceOnCanvasProps): React.JSX.Element {
  const t = useTranslation();
  const userId = useCurrentUserStore((state) => state.user?.id ?? '');
  const asset = useTimelineAsset(projectId, row.resultAssetId ?? '').data;
  const controls = useSceneControls(projectId, userId);
  const [placing, setPlacing] = React.useState(false);
  // Read by a second choice while one placement waits and by the warning on leaving.
  const placingRef = React.useRef(false);
  const settle = React.useCallback((value: boolean): void => {
    placingRef.current = value;
    setPlacing(value);
  }, []);
  React.useEffect(() => () => {
    if (placingRef.current) toast.warning(t('spaces.webAnimation.placing'));
  }, [t]);
  const { refetch: refetchControls } = controls;
  const choose = React.useCallback((canvas: ProjectSpace): void => {
    const config = controls.data?.capture;
    if (config === undefined) {
      // The button waits while the settings are read, so only a failed read gets here.
      toast.error(t('spaces.webAnimation.canvasUnreachable'));
      void refetchControls();
      return;
    }
    if (asset === undefined || placingRef.current) return;
    settle(true);
    /** The canvas could not be reached: the button stops waiting and says so. */
    const unreachable = (): void => {
      settle(false);
      toast.error(t('spaces.webAnimation.canvasUnreachable'));
    };
    void placeVideoOnCanvas({
      projectId, spaceId: canvas.id, userId, origin: canvasOrigin(userId, projectId, canvas.id), syncTimeoutMs: config.canvasSyncTimeoutMs,
      video: {
        content: asset.fileUrl, coverUrl: asset.coverUrl ?? undefined, duration: asset.durationSeconds ?? rowSeconds(row),
        mediaWidth: asset.width ?? row.input.width, mediaHeight: asset.height ?? row.input.height, mimeType: asset.mimeType, size: asset.sizeBytes,
        sourceAnimation: { spaceId: row.spaceId, executionId: row.source.executionId, videoUrl: asset.fileUrl },
      },
      // The button waits from the choice until collab confirms the node.
      onReceipt: () => settle(false),
    }).then((outcome) => {
      if (outcome.status === 'unreachable') unreachable();
      // The canvas's size gate has already said it is full.
      else if (outcome.status === 'refused') settle(false);
      else {
        const { nodeId } = outcome;
        toast.success(t('spaces.webAnimation.placed', { name: canvas.name }), { action: { label: t('spaces.webAnimation.viewPlaced'), onClick: () => useCanvasRevealStore.getState().reveal(canvas.id, nodeId) } });
      }
    }, unreachable);
  }, [asset, controls.data, refetchControls, settle, projectId, row, userId, t]);
  const waiting = placing || controls.isPending;
  const [open, setOpen] = React.useState(false);
  // A press while the button waits opens nothing: the menu opens on pointer down, which the waiting button does not swallow.
  const openMenu = React.useCallback((next: boolean): void => setOpen(next && !waiting), [waiting]);
  if (canvases.length === 0) {
    return <BarButton testId='motion-action-place-on-canvas' label={t('spaces.webAnimation.noCanvas')} icon={PLACE_ICON} disabled />;
  }
  return <DropdownMenu open={open} onOpenChange={openMenu}>
    <DropdownMenuTrigger asChild>
      <BarButton testId='motion-action-place-on-canvas' label={t('spaces.webAnimation.placeOnCanvas')} icon={PLACE_ICON}
        loading={waiting} disabled={asset === undefined} />
    </DropdownMenuTrigger>
    <DropdownMenuContent side='top' align='start' sideOffset={BAR_MENU_OFFSET} className='w-52'>
      <DropdownMenuLabel>{t('spaces.webAnimation.chooseCanvas')}</DropdownMenuLabel>
      {canvases.map((canvas) => <DropdownMenuItem key={canvas.id} data-testid={`motion-canvas-${canvas.id}`} onSelect={() => { setOpen(false); choose(canvas); }}>
        <span className='truncate'>{canvas.name}</span>
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** The details popover's props. */
interface DetailsProps {
  row: WebAnimationRowView;
  /** Whether its popover is open; opening an annotation closes it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unresolvedOnBase: number;
  /** Opens the result a modification started from, at its earliest open annotation. */
  onOpenBase: () => void;
  /** Whether that result is being read by id, which the button waits for. */
  baseReading: boolean;
}

/**
 * The details of the result in the preview (#1490 design §7.2): its title, request or source, steps, usage, and the
 * result it was modified from with that result's open annotations. The preview only holds succeeded results.
 * @param props - The row and what the details offer.
 * @param props.row - The row.
 * @param props.open - Whether the popover is open.
 * @param props.onOpenChange - Opens or closes it.
 * @param props.unresolvedOnBase - Open annotations on the result a modification started from.
 * @param props.onOpenBase - Opens the result a modification started from.
 * @param props.baseReading - Whether that result is being read by id.
 * @returns The popover.
 * @throws {never} Never.
 */
function Details({ row, open, onOpenChange, unresolvedOnBase, onOpenBase, baseReading }: DetailsProps): React.JSX.Element {
  const t = useTranslation();
  const base = row.kind === 'web_animation_modify' ? row.base : null;
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <BarButton testId='motion-details' label={t('spaces.webAnimation.details')} icon={DETAILS_ICON} />
    </PopoverTrigger>
    <PopoverContent side='top' align='end' sideOffset={BAR_MENU_OFFSET} className='flex w-80 flex-col gap-2 p-3 text-xs'>
      <span className='break-words font-medium'>{webAnimationTitle(row, t)}</span>
      <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
        {/* A create or modification is headed by its prompt or instruction already; an export's heading is not its source. */}
        {row.kind === 'web_animation_export' && <>
          <dt className='text-muted-foreground'>{t('spaces.webAnimation.sourceLabel')}</dt>
          <dd className='min-w-0 break-words'>{requestTitle(row.source, t)}</dd>
        </>}
        <dt className='text-muted-foreground'>{t('timeline.webAnimation.usageLabel')}</dt>
        <dd>{t('timeline.webAnimation.usage', { credits: formatCredits(row.usageCredits, getLocale()) })}</dd>
        {base !== null && <>
          <dt className='text-muted-foreground'>{t('spaces.webAnimation.modifiedFromLabel')}</dt>
          <dd><Button type='button' variant={null} size={null} className='text-left underline' loading={baseReading} onClick={onOpenBase}>
            {unresolvedOnBase > 0 ? t('spaces.webAnimation.baseWithAnnotations', { base: base.request, count: unresolvedOnBase }) : base.request}
          </Button></dd>
        </>}
      </dl>
      <ol className='flex flex-col gap-1'>
        {executionStepKeys(row.kind).map((key) => <li key={key} className='flex items-center gap-2'><Check className='size-3.5 shrink-0' />{t(key)}</li>)}
      </ol>
    </PopoverContent>
  </Popover>;
}

/**
 * The Motion Space (#1490 design §7): the selected result fills the Space; one floating bar at the bottom holds
 * playback, the result's actions, its details and, at the right end, Executions, Annotations and New. The two panels
 * open one at a time, docked inside the Space on the right.
 * @param props - The Space, the Project and the user's role.
 * @param props.projectId - The Project.
 * @param props.spaceId - The Motion Space.
 * @param props.readOnly - Whether the user is a Viewer.
 * @param props.myRole - The user's role.
 * @returns The Space.
 * @throws {never} Never.
 */
export function WebAnimationSpace({ projectId, spaceId, readOnly = true, myRole = 'viewer' }: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const viewerId = useCurrentUserStore((state) => state.user?.id);
  const limitsRead = useTimelineLimitsQuery(projectId);
  const limits = limitsRead.data?.webAnimation;
  // New, Modify and Run again open the dialog these settings bound, so they wait while the settings are read.
  const limitsWaiting = limits === undefined && (limitsRead.isPending || limitsRead.isFetching);
  const limitsFailed = limits === undefined && limitsRead.isError;
  const { refetch: refetchLimits } = limitsRead;
  const lists = useMotionLists(projectId, spaceId);
  const spaces = useProjectSpaceList(projectId);
  const canvases = React.useMemo(() => canvasesOldestFirst(spaces), [spaces]);
  const connection = useSpaceConnection();
  const doc = React.useMemo(() => getDoc(docName.webAnimationSpace(projectId, spaceId)), [projectId, spaceId]);
  const readWho = React.useCallback(() => ({ role: myRole, viewerId }), [myRole, viewerId]);
  const store = React.useMemo(() => webAnimationAnnotationStore({ doc, readWho }), [doc, readWho]);
  const docReady = connection.hasEverSynced;
  const annotationsWritable = !readOnly && docReady && connection.writeAccess !== 'denied';

  // Panels and selection (design §13.2, §13.8).
  const [panels, dispatchPanels] = React.useReducer(transitionMotionPanels, MOTION_PANELS_CLOSED);
  const [selection, setSelection] = React.useState<SelectionState<WebAnimationRowView>>(SELECTION_NONE);
  const selectionRef = React.useRef(selection);
  const requestSeq = React.useRef(0);
  const select = React.useCallback((event: SelectionEvent<WebAnimationRowView>): void => {
    const { state, effects } = transitionWebAnimationSelection(selectionRef.current, event);
    selectionRef.current = state;
    setSelection(state);
    for (const effect of effects) {
      if (effect.type === 'reveal') dispatchPanels({ type: 'reveal', tab: effect.tab, executionId: effect.executionId });
      if (effect.type === 'toast_not_found') toast.warning(t('spaces.webAnimation.notFound'));
      if (effect.type === 'fetch') {
        timelineApi.getExecution(projectId, spaceId, effect.executionId).then((row) => select({ type: 'fetched', requestId: effect.requestId, row }), () => select({ type: 'fetch_failed', requestId: effect.requestId }));
      }
    }
  }, [projectId, spaceId, t]);
  // While another row is read by id, the preview keeps the one it showed (design §13.2).
  const selected = shown(selection) ?? undefined;
  const selectedId = selected?.id ?? null;
  // The annotation panel groups threads by result (design §10.1): a result an annotation points at on no loaded page,
  // other than the shown one, is read by id under the key the shown one is read under below, so a change in the
  // Space's document reads it again too.
  const threads = useThreads(store);
  const unlistedIds = React.useMemo(() => [...new Set(threads.flatMap((thread) => {
    const anchor = thread.deletedAt === undefined ? readWebAnimationAnchor(thread.metadata) : null;
    return anchor === null || lists.byId.has(anchor.executionId) || anchor.executionId === selectedId ? [] : [anchor.executionId];
  }))], [threads, lists.byId, selectedId]);
  const unlistedRows = useQueries({
    queries: unlistedIds.map((id) => ({
      queryKey: [...spaceTasksQueryKey(projectId, spaceId), 'motion-held', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => timelineApi.getExecution(projectId, spaceId, id, signal),
      staleTime: Infinity,
    })),
    combine: rowsRead,
  });
  // A row by id: its copy on a loaded page, the shown row as the selection last saw it, or its read by id.
  const rowById = React.useCallback((id: string): WebAnimationRowView | undefined => {
    const held = shown(selectionRef.current);
    return lists.byId.get(id) ?? (held?.id === id ? held : undefined) ?? unlistedRows.get(id);
  }, [lists.byId, unlistedRows]);
  // The result being read by id: the button that asked for it waits until it lands, and no annotation starts meanwhile.
  const readingId = selection.status === 'fetching' ? selection.executionId : null;
  // A shown row on no loaded page is read under the Space-task key, so a change in the Space's document reads it again
  // as it reads the lists; it starts from the copy the selection holds.
  const heldId = selectedId !== null && !lists.byId.has(selectedId) ? selectedId : null;
  const heldRead = useQuery({
    queryKey: [...spaceTasksQueryKey(projectId, spaceId), 'motion-held', heldId],
    queryFn: ({ signal }) => timelineApi.getExecution(projectId, spaceId, heldId ?? '', signal),
    enabled: heldId !== null,
    initialData: heldId === null ? undefined : selected,
    staleTime: Infinity,
  });
  // The shown row is never missing while one is selected: the freshest listed copy, or the held row as last read.
  const row = selected === undefined ? undefined : lists.byId.get(selected.id) ?? (heldRead.data?.id === selected.id ? heldRead.data : selected);
  const locate = React.useCallback((executionId: string, threadId: string | null): void => {
    requestSeq.current += 1;
    select({ type: 'locate', executionId, row: rowById(executionId) ?? null, requestId: requestSeq.current, threadId });
  }, [rowById, select]);
  const pick = React.useCallback((picked: WebAnimationRowView): void => select({ type: 'pick', row: picked }), [select]);

  // With nothing selected, the newest finished result opens once the list is there (design §7.1): on entering, after
  // an open request that names no result, and after a named result could not be read.
  React.useEffect(() => {
    if (lists.succeeded.own.data === undefined || selection.status !== 'none') return;
    const newest = rowsOf(lists.succeeded.own)[0] ?? rowsOf(lists.succeeded.legacy)[0];
    if (newest !== undefined) pick(newest);
  }, [selection.status, lists.succeeded.own, lists.succeeded.legacy, pick]);
  // With nothing to show, the preview tells the Completed list's state (design §7.3).
  const succeededShows = listShows(lists.succeeded.own, lists.succeeded.legacy);
  const { refetch: refetchSucceededOwn } = lists.succeeded.own;
  const { refetch: refetchSucceededLegacy } = lists.succeeded.legacy;
  const retrySucceeded = React.useCallback((): void => { void refetchSucceededOwn(); void refetchSucceededLegacy(); }, [refetchSucceededOwn, refetchSucceededLegacy]);
  // The selection keeps the freshest copy of its row; running this again with the copy it holds (the Space shown again, a
  // new `select`) asks for nothing.
  React.useEffect(() => {
    if (row !== undefined) select({ type: 'row_changed', row });
  }, [row, select]);

  // Esc closes the open panel, unless a card, popover or text box above it took the press (it prevents the default).
  React.useEffect(() => {
    /**
     * Close the panel on Esc.
     * @param event - The key.
     */
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) dispatchPanels({ type: 'escape' }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Playback over the shown result.
  const durationSeconds = row === undefined ? 0 : rowSeconds(row);
  const clock = useMotionClock(row?.status === 'succeeded' ? durationSeconds : 0, selectedId);
  // Only the clock's stable parts reach callbacks and effects; its time changes every frame of play.
  const { pause: pauseClock, seek: seekClock } = clock;
  const clockTime = React.useRef(clock.time);
  clockTime.current = clock.time;
  const fps = row === undefined ? { num: 24, den: 1 } : row.input.fps;
  const frame = Math.min(Math.round(clock.time * fps.num / fps.den), Math.max(0, Math.round(durationSeconds * fps.num / fps.den) - 1));

  // Every change of the shown result passes the annotation draft first (design §13.7 switch_result): a draft without
  // words closes; one with words asks, and the switch waits for the user to agree to discard it.
  // The card of a thread the user just wrote opens; set once the annotations below exist.
  const showWritten = React.useRef<(threadId: string) => void>(() => undefined);
  const [annotation, setAnnotation] = React.useState(ANNOTATION_DRAFT_IDLE);
  // Which close of a draft with words the user is asked to confirm.
  const [discardAsked, setDiscardAsked] = React.useState<'cancel' | 'switch_result' | null>(null);
  const annotationRef = React.useRef(annotation);
  const annotate = React.useCallback((event: AnnotationDraftEvent): void => {
    const { state, effects } = transitionAnnotationDraft(annotationRef.current, event);
    annotationRef.current = state;
    setAnnotation(state);
    for (const effect of effects) {
      if (effect.type === 'pause') pauseClock();
      if (effect.type === 'toast_disconnected') toast.warning(t('spaces.webAnimation.annotationDisconnected'));
      if (effect.type === 'toast_failed' && effect.reason !== 'space_full') toast.error(t('spaces.webAnimation.annotationFailed'));
      if (effect.type === 'confirm_discard') setDiscardAsked(event.type === 'switch_result' ? 'switch_result' : 'cancel');
      if (effect.type === 'write') {
        store.createThread({ initialComment: { body: asCommentBody(effect.text.trim()) }, metadata: { webAnimationAnchor: effect.anchor } }).then((thread) => {
          annotate({ type: 'written' });
          showWritten.current(thread.id);
        }, (err: unknown) => annotate({ type: 'write_failed', reason: err instanceof SpaceFullError ? 'space_full' : 'failed' }));
      }
    }
  }, [pauseClock, store, t]);
  const pendingSwitch = React.useRef<(() => void) | null>(null);
  const showResult = React.useCallback((go: () => void): void => {
    annotate({ type: 'switch_result', confirmed: false });
    const now = annotationRef.current.status;
    if (now === 'writing') pendingSwitch.current = go;
    else if (now === 'idle') go();
  }, [annotate]);
  const locateShown = React.useCallback((executionId: string): void => showResult(() => locate(executionId, null)), [showResult, locate]);

  // An open request aimed at this Space (design §8.5): select its execution, then say it was handled.
  const openRequest = useSpaceOpenRequestStore((state) => state.state);
  React.useEffect(() => {
    if (openRequest.status !== 'opened' || openRequest.spaceId !== spaceId) return;
    const target = openRequest.request.select;
    if (target !== undefined) locateShown(target);
    useSpaceOpenRequestStore.getState().dispatch({ type: 'handled' });
  }, [openRequest, spaceId, locateShown]);

  // Running, accepting and cancelling (design §4.2).
  // Reads this Space's lists again; a button that changed them waits for this read, so it stops waiting only once the
  // result is on screen.
  const refresh = React.useCallback((): Promise<void> => queryClient.invalidateQueries({ queryKey: spaceTasksQueryKey(projectId, spaceId) }), [queryClient, projectId, spaceId]);
  // `intent` is what the button waits on, and a press while it waits sends nothing; `actionId` is fresh for every press
  // that does send.
  const accept = React.useCallback((request: WebAnimationAcceptRequest, intent: string, actionId: string, onRefused?: (message: string | null) => void): void => {
    if (getRunning(intent) !== undefined) return;
    void runOnce(intent, {
      scope: 'timeline-execution',
      prepare: () => ({ ...request, projectId, spaceId, actionId } as WebAnimationAcceptBody),
      send: async (key, body) => {
        const answer = await timelineApi.acceptExecution(body, key);
        await refresh();
        return answer;
      },
    }).then((outcome) => {
      // A press let go without an answer gives the draft back with the unknown result; an export has nothing to give back.
      if (outcome.kind === 'released') {
        onRefused?.(t('common.runOnce.unknownResult'));
        return;
      }
      if (outcome.kind === 'failed') {
        // A spend limit is told in a toast with its reset day, as at every entry that starts work, and the dialog
        // comes back with its input (inner#1968, design 3.3a).
        const capped = refusalSentence(outcome.error);
        const message = capped ?? serverMessage(outcome.error, t('common.runOnce.unknownResult'));
        if (onRefused === undefined || capped !== null) toast.error(message);
        onRefused?.(capped === null ? message : null);
        return;
      }
      const { row: accepted } = outcome.result;
      // The preview keeps its result unless the answer is a succeeded row; the list opens on the row (design §7.3).
      if (accepted.status === 'succeeded') showResult(() => select({ type: 'accepted', row: accepted }));
      else select({ type: 'accepted', row: accepted });
      // Only the draft's own action closes it, a replay of that action included; an export's answer never does.
      dispatchDraft({ type: 'accepted', actionId });
    });
  }, [projectId, spaceId, select, showResult, refresh, t]);
  const cancel = React.useCallback((target: WebAnimationRowView): void => {
    if (readOnly) return;
    void runOnce(cancelIntent(target.id), {
      scope: 'timeline-execution',
      prepare: () => target.id,
      send: async (key, id) => {
        const row = await timelineApi.cancelExecution(id, projectId, key);
        await refresh();
        return row;
      },
      onFailure: (err) => { toast.error(serverMessage(err, t('common.runOnce.unknownResult'))); },
    });
  }, [readOnly, projectId, refresh, t]);

  // New and Modify (design §5.1).
  const [draft, dispatchDraft] = React.useReducer(transitionCreationDraft, CREATION_DRAFT_CLOSED);
  const [retryDialog, setRetryDialog] = React.useState(false);
  const openDialog = React.useCallback((input: Partial<CreationDraftInput>, retry = false): void => {
    if (readOnly) return;
    if (limits === undefined) {
      // The buttons wait while the settings are read, so only a failed read gets here.
      if (limitsFailed) {
        toast.error(t('spaces.webAnimation.limitsUnavailable'));
        void refetchLimits();
      }
      return;
    }
    const aspect = limits.aspects.find(isWebAnimationAspect) ?? '16:9';
    setRetryDialog(retry);
    dispatchDraft({ type: 'open', input: { base: null, prompt: '', engine: DEFAULT_WEB_ANIMATION_ENGINE, aspect, durationSeconds: limits.durationSeconds.default, ...input } });
  }, [readOnly, limits, limitsFailed, refetchLimits, t]);
  const openNew = React.useCallback((): void => openDialog({}), [openDialog]);
  const editDraft = React.useCallback((patch: Partial<CreationDraftInput>): void => dispatchDraft({ type: 'edit', patch }), []);
  const closeDraft = React.useCallback((): void => dispatchDraft({ type: 'close' }), []);
  const execute = React.useCallback((): void => {
    if (draft.status !== 'drafting' || readOnly) return;
    const { input } = draft;
    const actionId = newId();
    dispatchDraft({ type: 'execute', actionId });
    const common = { engine: input.engine, aspect: input.aspect, durationSeconds: input.durationSeconds };
    accept(input.base === null
      ? { kind: 'web_animation_create', prompt: input.prompt, ...common }
      : { kind: 'web_animation_modify', baseSourceVersionId: input.base.sourceVersionId, instruction: input.prompt, ...common },
    `web-animation-execution:${spaceId}:${actionId}`, actionId, (error) => dispatchDraft({ type: 'refused', error }));
  }, [draft, readOnly, spaceId, accept]);

  // The shown result's actions (design §7.2).
  const modify = React.useCallback((): void => {
    if (!playable(row)) return;
    openDialog({ base: { executionId: row.id, sourceVersionId: row.resultSourceVersionId, request: row.request }, aspect: row.input.aspect, durationSeconds: row.input.durationSeconds });
  }, [row, openDialog]);
  // Every export of a source version, from Export here or Export again on a failed export, waits on that version's one
  // intent.
  const sendExport = React.useCallback((source: string): void => {
    accept({ kind: 'web_animation_export', sourceVersionId: source }, exportIntent(spaceId, source), newId());
  }, [accept, spaceId]);
  const exportSource = playable(row) ? row.resultSourceVersionId : null;
  const exporting = useRunning(exportSource === null ? '' : exportIntent(spaceId, exportSource)) !== undefined;
  const exportVideo = React.useCallback((): void => {
    if (exportSource !== null) sendExport(exportSource);
  }, [exportSource, sendExport]);
  // Run again a row of the Failed tab: an export is sent again, a create or modification opens the dialog it was made
  // from (design §7.2).
  const retryRow = React.useCallback((target: WebAnimationRowView): void => {
    if (target.kind === 'web_animation_export') {
      sendExport(target.input.sourceVersionId);
      return;
    }
    const base = target.kind === 'web_animation_modify' ? { executionId: target.base.executionId, sourceVersionId: target.input.baseSourceVersionId, request: target.base.request } : null;
    openDialog({ base, prompt: target.request, aspect: target.input.aspect, durationSeconds: target.input.durationSeconds }, true);
  }, [sendExport, openDialog]);
  // The result a modification starts from: listed here, or read once when it is not.
  const baseId = draft.status !== 'closed' ? draft.input.base?.executionId ?? null : null;
  const listedBase = baseId === null ? undefined : rowById(baseId);
  const readBase = useQuery({
    queryKey: [...spaceTasksQueryKey(projectId, spaceId), 'motion-base', baseId],
    queryFn: ({ signal }) => timelineApi.getExecution(projectId, spaceId, baseId ?? '', signal),
    enabled: baseId !== null && listedBase === undefined,
    staleTime: Infinity,
  });
  const baseRow = listedBase ?? readBase.data;
  const { refetch: refetchBase } = readBase;
  const baseRead = React.useMemo(() => ({
    failed: listedBase === undefined && readBase.isError, retrying: readBase.isFetching, retry: () => void refetchBase(),
  }), [listedBase, readBase.isError, readBase.isFetching, refetchBase]);
  const exportRow = row !== undefined && row.kind !== 'web_animation_export' ? row.export ?? null : null;
  const viewVideo = React.useCallback((): void => { if (exportRow !== null) locateShown(exportRow.executionId); }, [exportRow, locateShown]);
  const viewSource = React.useCallback((): void => { if (row?.kind === 'web_animation_export') locateShown(row.source.executionId); }, [row, locateShown]);
  const exportAssetRead = useTimelineAsset(projectId, row?.kind === 'web_animation_export' ? row.resultAssetId ?? '' : '');
  const exportAsset = exportAssetRead.data;
  const { refetch: refetchExportAsset } = exportAssetRead;
  const retryExportAsset = React.useCallback((): void => { void refetchExportAsset(); }, [refetchExportAsset]);
  const download = React.useCallback((): void => { if (exportAsset !== undefined) downloadAsset(exportAsset.fileUrl); }, [exportAsset]);

  // Annotations (design §10): one owner opens a thread from every entry and keeps the unsent replies.
  const openAnnotationPanel = React.useCallback((): void => dispatchPanels({ type: 'open_thread' }), []);
  const focused = React.useCallback((threadId: string): void => select({ type: 'focused', threadId }), [select]);
  const annotations = useMotionAnnotations({
    threads, selectedId, focusThreadId: selection.status === 'selected' ? selection.focusThreadId : null,
    baseExecutionId: row?.kind === 'web_animation_modify' ? row.base.executionId : null,
    showResult, locate, openPanel: openAnnotationPanel, seek: seekClock, onFocused: focused,
  });
  const { resultThreads, activeThread, openThread, closeThread } = annotations;
  showWritten.current = annotations.showWritten;
  React.useEffect(() => { annotate(docReady ? { type: 'reconnect' } : { type: 'disconnect' }); }, [docReady, annotate]);
  const addAnnotation = React.useCallback((): void => {
    // The open card hides while the annotation is written and shows again after (design §13.7).
    // The anchor's time lies within the result (design §13.6).
    if (selectedId !== null) annotate({ type: 'add', executionId: selectedId, timeSeconds: anchorTimeWithin(clockTime.current, durationSeconds) });
  }, [selectedId, durationSeconds, annotate]);
  const clickFrame = React.useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (annotationRef.current.status !== 'picking' && annotationRef.current.status !== 'writing') return;
    const box = event.currentTarget.getBoundingClientRect();
    const point: FramePoint = { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
    annotate({ type: 'click_frame', point });
  }, [annotate]);
  const keepWriting = React.useCallback((open: boolean): void => {
    if (open) return;
    setDiscardAsked(null);
    pendingSwitch.current = null;
  }, []);
  const writeBox = React.useRef<HTMLDivElement>(null);
  /**
   * Put the user back in the annotation's text box when the discard question closes on Keep writing (design §13.7).
   * @param event - The dialog's close focus.
   */
  const backToWriting = React.useCallback((event: Event): void => {
    const input = writeBox.current?.querySelector('textarea');
    if (input == null) return;
    event.preventDefault();
    input.focus();
  }, []);
  const discard = React.useCallback((): void => {
    const asked = discardAsked;
    const go = pendingSwitch.current;
    setDiscardAsked(null);
    pendingSwitch.current = null;
    if (asked === null) return;
    annotate({ type: asked, confirmed: true });
    if (asked === 'switch_result') go?.();
  }, [discardAsked, annotate]);
  const typeAnnotation = React.useCallback((text: string): void => annotate({ type: 'type', text }), [annotate]);
  const sendAnnotation = React.useCallback((): void => annotate({ type: 'send' }), [annotate]);
  const cancelAnnotation = React.useCallback((): void => annotate({ type: 'cancel', confirmed: false }), [annotate]);
  const pickRow = React.useCallback((picked: WebAnimationRowView): void => showResult(() => pick(picked)), [showResult, pick]);
  const order = React.useMemo(() => [...rowsOf(lists.succeeded.own), ...rowsOf(lists.succeeded.legacy)].map((item) => item.id), [lists.succeeded.own, lists.succeeded.legacy]);
  const activeDraft = activeThread === null ? '' : annotations.drafts.get(activeThread.thread.id) ?? '';

  const toggleExecutions = React.useCallback((): void => dispatchPanels({ type: 'toggle_executions' }), []);
  const toggleAnnotations = React.useCallback((): void => dispatchPanels({ type: 'toggle_annotations' }), []);
  const closePanel = React.useCallback((): void => dispatchPanels({ type: 'escape' }), []);
  const pickTab = React.useCallback((tab: MotionTab): void => dispatchPanels({ type: 'pick_tab', tab }), []);
  const seekTo = React.useCallback((value: number[]): void => seekClock(value[0] ?? 0), [seekClock]);
  const seekValue = React.useMemo(() => [clock.time], [clock.time]);
  const panelOpen = panels.panel !== 'none';
  const frameStyle = React.useMemo(() => {
    const ratio = row === undefined ? 16 / 9 : ratioOf(row);
    return { aspectRatio: `${ratio}`, width: `min(100cqw, calc(100cqh * ${ratio}))` };
  }, [row]);
  const draftPoint = annotation.status === 'writing' ? annotation.point : null;
  // The cards over the frame are drawn in the Space and kept inside the preview area.
  const [spaceElement, setSpaceElement] = React.useState<HTMLDivElement | null>(null);
  const [previewArea, setPreviewArea] = React.useState<HTMLDivElement | null>(null);

  return <div ref={setSpaceElement} data-testid='motion-space' className='relative isolate h-full overflow-hidden bg-muted'>
    {panels.panel === 'executions' && <MotionExecutionsPanel lists={lists} tab={panels.tab} selectedId={selectedId} markedId={panels.marked} spaceId={spaceId} readOnly={readOnly}
      waitingLimits={limitsWaiting} onTab={pickTab} onPick={pickRow} onCancel={cancel} onRetry={retryRow} onClose={closePanel} />}
    {panels.panel === 'annotations' && <MotionAnnotationsPanel threads={threads} order={order} rowOf={rowById} activeThreadId={activeThread?.thread.id ?? null}
      filter={annotations.filter} onFilter={annotations.setFilter} viewportRef={annotations.viewportRef} onOpen={openThread} onClose={closePanel} />}
    <div ref={setPreviewArea} data-testid='motion-preview-area' className={cn('absolute bottom-[4.5rem] left-6 top-6 flex items-center justify-center', panelOpen ? 'right-[22rem]' : 'right-6')}
      style={{ containerType: 'size' }}>
      {row === undefined
        ? selection.status === 'fetching' || succeededShows === 'pending'
          ? <LoaderCircle data-testid='motion-loading' className='size-5 animate-spin text-muted-foreground' />
          : succeededShows === 'failed'
            ? <ListLoadError message={t('spaces.webAnimation.listError')} onRetry={retrySucceeded} />
            : <div data-testid='motion-empty' className='flex flex-col items-center gap-3 text-sm text-muted-foreground'>
              <span>{t('spaces.webAnimation.empty')}</span>
              {!readOnly && <Button data-testid='motion-empty-new' size='sm' className='gap-1.5' onClick={openNew} loading={limitsWaiting} icon={NEW_ICON}>{t('spaces.webAnimation.new')}</Button>}
            </div>
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a point on the frame is marked with the mouse only
        : <div data-testid='motion-preview' data-execution-id={row.id} className={cn('relative', annotation.status === 'picking' && 'cursor-crosshair')} style={frameStyle} onClick={clickFrame}>
          {playable(row) && <MotionResultPlayer projectId={projectId} executionId={row.id} sourceVersionId={row.resultSourceVersionId} input={row.input} frame={frame} />}
          {row.kind === 'web_animation_export' && <ExportVideo key={row.id} url={exportAsset?.fileUrl ?? null} assetFailed={exportAssetRead.isError}
            assetRetrying={exportAssetRead.isFetching} onAssetRetry={retryExportAsset} time={clock.time} playing={clock.playing} />}
          {playable(row) && resultThreads.filter(({ anchor }) => anchor.point !== null && Math.abs(anchor.timeSeconds - clock.time) < PIN_WINDOW_SECONDS).map(({ thread, anchor }) =>
            <Button key={thread.id} type='button' variant={null} size={null} data-testid={`motion-pin-${thread.id}`} aria-label={t('spaces.webAnimation.annotations')}
              onClick={(event) => { event.stopPropagation(); openThread(thread.id); }}
              className={cn(PIN_CLASS, thread.resolved ? 'bg-muted-foreground' : 'bg-comment-outline')}
              style={{ left: `${(anchor.point?.x ?? 0) * 100}%`, top: `${(anchor.point?.y ?? 0) * 100}%` }} />)}
          {annotation.status === 'picking' && <div className='pointer-events-none absolute inset-x-0 top-2 flex justify-center'>
            <span className='rounded-full bg-popover px-3 py-1 text-xs text-popover-foreground shadow-md'>{t('spaces.webAnimation.pickPoint')}</span></div>}
          {draftPoint !== null && <span data-testid='motion-draft-pin' className={cn(PIN_CLASS, 'pointer-events-none bg-comment-outline')}
            style={{ left: `${draftPoint.x * 100}%`, top: `${draftPoint.y * 100}%` }} />}
          {annotation.status !== 'idle' && <MotionFrameCard testId='motion-annotation-draft' point={draftPoint} boundary={previewArea} container={spaceElement} onClose={cancelAnnotation}>
            <div ref={writeBox} className='p-3'>
              <span className='mb-2 block text-2xs text-muted-foreground'>{t('spaces.webAnimation.annotateAt', { time: formatMotionTime(annotation.timeSeconds) })}</span>
              {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the box the user just asked for by pressing Add annotation; they expect to type immediately */}
              <DocumentCommentWriteBox name='motion-annotation' autoFocus value={annotation.status === 'picking' ? '' : annotation.text} placeholder={t('spaces.webAnimation.annotationPlaceholder')}
                onChange={typeAnnotation} onSave={sendAnnotation} onCancel={cancelAnnotation} />
            </div>
          </MotionFrameCard>}
          {activeThread !== null && annotation.status === 'idle'
            && <MotionFrameCard key={activeThread.thread.id} testId='motion-thread-card-popover' point={activeThread.anchor.point} boundary={previewArea} container={spaceElement}
              onClose={closeThread} className='w-auto border-0 bg-transparent shadow-none'>
              <MotionThreadCard thread={activeThread.thread} timeSeconds={activeThread.anchor.timeSeconds} store={store} myRole={myRole} viewerId={viewerId} canWrite={annotationsWritable}
                draft={activeDraft} onDraft={annotations.setDraft} />
            </MotionFrameCard>}
        </div>}
    </div>
    <div data-testid='motion-bottom-bar' className='absolute inset-x-3 bottom-3 z-10 flex h-12 items-center gap-1 rounded-chrome border border-border bg-popover px-2 shadow'>
      <BarButton testId='motion-play' filled label={t(clock.playing ? 'timeline.pause' : 'timeline.play')} icon={clock.playing ? PAUSE_ICON : PLAY_ICON}
        onClick={clock.toggle} disabled={row === undefined} />
      <span className='mx-2 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground'>
        {row === undefined ? '—' : `${formatMotionTime(clock.time)} / ${formatMotionTime(durationSeconds)}`}
      </span>
      <div className='relative mr-2 flex h-8 min-w-24 flex-1 items-center'>
        <Slider aria-label={t('timeline.seek')} value={seekValue} onValueChange={seekTo} min={0} max={Math.max(0.01, durationSeconds)} step={0.01} disabled={row === undefined} className='w-full' />
        {/* A 24px-wide transparent hit area above the track around the 6x10 mark, placed where the Slider puts its thumb
            for that time: Radix keeps the 12px thumb inside the track, so its centre runs from 6px to the width less 6px. */}
        {playable(row) && docReady && resultThreads.map(({ thread, anchor }) => <Tooltip key={thread.id}>
          <TooltipTrigger asChild>
            <Button type='button' variant={null} size={null} data-testid={`motion-marker-${thread.id}`}
              aria-label={threadSummary(thread)} onClick={() => openThread(thread.id)} className='absolute top-0 flex h-3 w-6 -translate-x-1/2 justify-center'
              style={{ left: `calc(6px + (100% - 12px) * ${anchor.timeSeconds / Math.max(0.01, durationSeconds)})` }}>
              <span className={cn('h-2.5 w-1.5 rounded-sm', thread.resolved ? 'bg-muted-foreground' : 'bg-comment-outline')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent className='line-clamp-3 max-w-64'>{threadSummary(thread)}</TooltipContent>
        </Tooltip>)}
      </div>
      {row !== undefined && <>
        <Separator orientation='vertical' className='mx-1 h-5' />
        {playable(row) && <>
          {!readOnly && <BarButton testId='motion-action-add-annotation' label={t('spaces.webAnimation.addAnnotation')} icon={ADD_ANNOTATION_ICON}
            pressed={annotation.status !== 'idle'} onClick={addAnnotation} disabled={!annotationsWritable} loading={!docReady || readingId !== null} />}
          {!readOnly && <BarButton testId='motion-action-modify' label={t('spaces.webAnimation.modify')} icon={MODIFY_ICON} onClick={modify} loading={limitsWaiting} />}
          {exportRow !== null
            ? <BarButton testId='motion-action-view-video' label={t('spaces.webAnimation.viewVideo')} icon={VIDEO_ICON} onClick={viewVideo}
              loading={readingId !== null && readingId === exportRow.executionId} />
            : !readOnly && <BarButton testId='motion-action-export' label={t('spaces.webAnimation.export')} icon={EXPORT_ICON} onClick={exportVideo} loading={exporting} />}
        </>}
        {row.kind === 'web_animation_export' && <>
          <BarButton testId='motion-action-download' label={t('spaces.webAnimation.download')} icon={DOWNLOAD_ICON} onClick={download} disabled={exportAsset === undefined} />
          {!readOnly && <PlaceOnCanvas projectId={projectId} row={row} canvases={canvases} />}
          <BarButton testId='motion-action-view-source' label={t('spaces.webAnimation.viewSource')} icon={SOURCE_ICON} onClick={viewSource}
            loading={readingId !== null && readingId === row.source.executionId} />
        </>}
        <Details row={row} open={annotations.detailsOpen} onOpenChange={annotations.setDetailsOpen} unresolvedOnBase={annotations.openOnBaseCount}
          onOpenBase={annotations.openBase} baseReading={readingId !== null && row.kind === 'web_animation_modify' && readingId === row.base.executionId} />
      </>}
      <Separator orientation='vertical' className='mx-1 h-5' />
      <BarButton testId='motion-open-executions' label={t('spaces.webAnimation.executions')} icon={EXECUTIONS_ICON} pressed={panels.panel === 'executions'}
        count={lists.totals.running} onClick={toggleExecutions} />
      <BarButton testId='motion-open-annotations' label={t('spaces.webAnimation.annotations')} icon={ANNOTATIONS_ICON} pressed={panels.panel === 'annotations'}
        count={docReady ? annotations.unresolvedCount : 0} onClick={toggleAnnotations} loading={!docReady} />
      {!readOnly && <BarButton testId='motion-new' label={t('spaces.webAnimation.new')} icon={NEW_ICON} onClick={openNew} loading={limitsWaiting} />}
    </div>
    <AlertDialog open={discardAsked !== null} onOpenChange={keepWriting}>
      <AlertDialogContent onCloseAutoFocus={backToWriting}>
        <AlertDialogHeader><AlertDialogTitle>{t('spaces.webAnimation.discardAnnotation')}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('spaces.webAnimation.keepWriting')}</AlertDialogCancel>
          <AlertDialogAction data-testid='motion-discard-annotation' variant='destructive' onClick={discard}>{t('spaces.webAnimation.discard')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {draft.status !== 'closed' && draft.open && limits !== undefined && <WebAnimationDialog projectId={projectId} spaceId={spaceId} draft={draft} retry={retryDialog} limits={limits} baseRow={baseRow} baseRead={baseRead}
      onEdit={editDraft} onExecute={execute} onClose={closeDraft} />}
  </div>;
}

/** An exported video, driven by the play bar. */
interface ExportVideoProps {
  url: string | null;
  /** Whether reading the video's asset failed, whether that read is being retried, and the retry. */
  assetFailed: boolean;
  assetRetrying: boolean;
  onAssetRetry: () => void;
  time: number;
  playing: boolean;
}

/**
 * An exported video in the preview, kept on the play bar's time; its own controls are not drawn. A video whose asset
 * could not be read, or that failed to load, shows unavailable with a retry (design §7.3).
 * @param props - The video and the clock.
 * @param props.url - The video's address, once resolved.
 * @param props.assetFailed - Whether reading its asset failed.
 * @param props.assetRetrying - Whether that read is being retried.
 * @param props.onAssetRetry - Reads its asset again.
 * @param props.time - The play bar's time.
 * @param props.playing - Whether the play bar plays.
 * @returns The video.
 * @throws {never} Never.
 */
function ExportVideo({ url, assetFailed, assetRetrying, onAssetRetry, time, playing }: ExportVideoProps): React.JSX.Element {
  const video = React.useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = React.useState(false);
  // A new element loads the video again.
  const [attempt, setAttempt] = React.useState(0);
  const markBroken = React.useCallback((): void => setBroken(true), []);
  const retry = React.useCallback((): void => {
    if (assetFailed) onAssetRetry();
    setBroken(false);
    setAttempt((current) => current + 1);
  }, [assetFailed, onAssetRetry]);
  // Both run again when the element mounts: a press or a seek made while the address was read reaches it then. A hidden
  // Space runs this cleanup and stops the play bar's clock, so the video stops with it.
  React.useEffect(() => {
    const element = video.current;
    if (element === null) return undefined;
    if (playing) void element.play().catch(() => {});
    else element.pause();
    return () => element.pause();
  }, [playing, attempt, url]);
  React.useEffect(() => {
    const element = video.current;
    if (element !== null && !playing && Math.abs(element.currentTime - time) > 0.05) element.currentTime = time;
  }, [time, playing, attempt, url]);
  if (assetFailed || broken) return <div className='relative size-full overflow-hidden rounded-chrome'><PreviewUnavailable onRetry={retry} retrying={assetRetrying} /></div>;
  return url === null ? <div className='size-full rounded-chrome bg-card' />
    : <video key={attempt} ref={video} src={url} muted playsInline preload='auto' onError={markBroken} className='size-full rounded-chrome bg-black object-contain' />;
}
