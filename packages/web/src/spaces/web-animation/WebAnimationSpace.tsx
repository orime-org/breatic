// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadData } from '@blocknote/core/comments';
import {
  Check, CircleSlash, Dot, Download, Ellipsis, LayoutGrid, List, LoaderCircle, MessageSquare,
  MessageSquarePlus, Pause, Pencil, Play, Plus, RotateCcw, Undo2, Upload, Video, X,
} from 'lucide-react';
import { formatCredits, getLocale, newId } from '@breatic/shared';
import { readWebAnimationAnchor, webAnimationExecutionEnded, webAnimationExecutionFailed, type WebAnimationRowView } from '@breatic/shared/space-content';

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@web/components/ui/alert-dialog';
import { Button } from '@web/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@web/components/ui/popover';
import { Separator } from '@web/components/ui/separator';
import { Slider } from '@web/components/ui/slider';
import { getSceneControls, spaceTasksQueryKey } from '@web/data/api/scene';
import { serverMessage } from '@web/data/api/server-message';
import { timelineApi, type WebAnimationAcceptBody, type WebAnimationAcceptRequest } from '@web/data/api/timeline';
import { useProjectSpaceList, type ProjectSpace } from '@web/data/yjs/project-meta';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { useTranslation } from '@web/i18n/use-translation';
import { downloadAsset } from '@web/lib/download';
import { readSpaceViewport } from '@web/lib/project-tabs-storage';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import type { SpaceBodyProps } from '@web/spaces';
import { placeVideoOnCanvas } from '@web/spaces/canvas/place-video-on-canvas';
import { DocumentCommentWriteBox } from '@web/spaces/document/DocumentCommentWriteBox';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { SpaceFullError } from '@web/spaces/document/document-comment-thread-store';
import { bodyText } from '@web/spaces/document/use-comment-cards';
import { useTimelineAsset } from '@web/spaces/timeline/use-timeline-asset';
import { useTimelineLimits } from '@web/spaces/timeline/use-timeline-limits';
import { ANNOTATION_DRAFT_IDLE, transitionAnnotationDraft, type AnnotationDraftEvent, type FramePoint } from '@web/spaces/web-animation/annotation-draft';
import { webAnimationAnnotationStore } from '@web/spaces/web-animation/annotation-thread-store';
import { CANVAS_PLACEMENT_IDLE, transitionCanvasPlacement, type CanvasPlacementEvent } from '@web/spaces/web-animation/canvas-placement';
import { transitionCreationDraft, type CreationDraftInput, type CreationDraftState } from '@web/spaces/web-animation/creation-draft';
import { DEFAULT_WEB_ANIMATION_ENGINE, cancelIntent, executionStepKeys, failureSentenceKey, phaseKey, stepMark } from '@web/spaces/web-animation/execution-text';
import { MOTION_PANELS_CLOSED, transitionMotionPanels, type MotionPanelsEvent, type MotionTab } from '@web/spaces/web-animation/motion-panels';
import { BarButton, rowSeconds, rowTitle } from '@web/spaces/web-animation/motion-parts';
import { requestTitle } from '@web/spaces/web-animation/web-animation-title';
import { MotionAnnotationsPanel, formatAnnotationTime } from '@web/spaces/web-animation/MotionAnnotationsPanel';
import { MotionExecutionsPanel } from '@web/spaces/web-animation/MotionExecutionsPanel';
import { MotionResultPlayer } from '@web/spaces/web-animation/MotionResultPlayer';
import { MotionThreadCard } from '@web/spaces/web-animation/MotionThreadCard';
import { useMotionClock } from '@web/spaces/web-animation/use-motion-clock';
import { rowsOf, useMotionLists } from '@web/spaces/web-animation/use-motion-lists';
import { WebAnimationDialog } from '@web/spaces/web-animation/WebAnimationDialog';
import { SELECTION_NONE, transitionWebAnimationSelection, type SelectionEvent, type SelectionState } from '@web/spaces/web-animation/web-animation-selection';
import { useCurrentUserStore } from '@web/stores';
import { useCanvasRevealStore } from '@web/stores/canvas-reveal';
import { useSpaceOpenRequestStore } from '@web/stores/space-open-request';
import { runOnce, useRunning } from '@web/stores/task-actions-in-flight';

/** How close to the playhead an annotation's point shows on the frame, in seconds. */
const PIN_WINDOW_SECONDS = 0.15;
const CLOSED_DRAFT: CreationDraftState = { status: 'closed' };

/** A row whose result can be played: a finished create or modification. */
type PlayableRow = Extract<WebAnimationRowView, { kind: 'web_animation_create' | 'web_animation_modify' }>;

/**
 * Whether a row is a finished create or modification, whose result plays and takes annotations.
 * @param row - The row.
 * @returns True for one.
 * @throws {never} Never.
 */
function playable(row: WebAnimationRowView | undefined): row is PlayableRow & { resultSourceVersionId: string } {
  return row !== undefined && row.kind !== 'web_animation_export' && row.status === 'succeeded' && row.resultSourceVersionId !== null;
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

/**
 * Where a canvas starts looking for room: the middle of its last view here, or its origin.
 * @param userId - The signed-in account.
 * @param projectId - The project.
 * @param canvasId - The canvas.
 * @returns A point in canvas coordinates.
 * @throws {never} Never.
 */
function canvasOrigin(userId: string, projectId: string, canvasId: string): { x: number; y: number } {
  const view = readSpaceViewport(userId, projectId, canvasId);
  if (view === null || view.zoom <= 0) return { x: 0, y: 0 };
  // ponytail: the window stands in for the canvas pane, whose size is unknown while its tab is closed.
  return { x: (window.innerWidth / 2 - view.x) / view.zoom, y: (window.innerHeight / 2 - view.y) / view.zoom };
}

/**
 * The Space's annotation threads, kept current from its thread store.
 * @param store - The store.
 * @returns The threads.
 * @throws {never} Never.
 */
function useThreads(store: ReturnType<typeof webAnimationAnnotationStore>): ThreadData[] {
  const [threads, setThreads] = React.useState<ThreadData[]>(() => [...store.getThreads().values()]);
  React.useEffect(() => {
    setThreads([...store.getThreads().values()]);
    return store.subscribe((all) => setThreads([...all.values()]));
  }, [store]);
  return threads;
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
  const controls = useQuery({ queryKey: ['scene-controls', projectId, userId], queryFn: ({ signal }) => getSceneControls(projectId, signal) });
  const [placement, setPlacement] = React.useState(CANVAS_PLACEMENT_IDLE);
  const [open, setOpen] = React.useState(false);
  const latest = React.useRef(placement);
  latest.current = placement;
  const fire = React.useCallback((event: CanvasPlacementEvent): void => {
    const { state, effects } = transitionCanvasPlacement(latest.current, event);
    latest.current = state;
    setPlacement(state);
    for (const effect of effects) {
      if (effect.type === 'toast_unreachable') toast.error(t('spaces.webAnimation.canvasUnreachable'));
      if (effect.type === 'toast_placed') {
        const name = canvases.find((canvas) => canvas.id === effect.canvasId)?.name ?? '';
        toast.success(t('spaces.webAnimation.placed', { name }), { action: { label: t('spaces.threeD.viewfinder.view'), onClick: () => useCanvasRevealStore.getState().reveal(effect.canvasId, effect.nodeId) } });
      }
      if (effect.type === 'warn_in_progress') toast.warning(t('spaces.webAnimation.placing'));
    }
  }, [canvases, t]);
  React.useEffect(() => () => {
    if (latest.current.status !== 'idle') toast.warning(t('spaces.webAnimation.placing'));
  }, [t]);
  const choose = React.useCallback((canvas: ProjectSpace): void => {
    setOpen(false);
    const config = controls.data?.capture;
    if (asset === undefined || config === undefined || latest.current.status !== 'idle') return;
    fire({ type: 'choose', canvasId: canvas.id });
    void placeVideoOnCanvas({
      projectId, spaceId: canvas.id, userId, origin: canvasOrigin(userId, projectId, canvas.id), syncTimeoutMs: config.canvasSyncTimeoutMs,
      video: {
        content: asset.fileUrl, coverUrl: asset.coverUrl ?? undefined, duration: asset.durationSeconds ?? rowSeconds(row),
        mediaWidth: asset.width ?? row.input.width, mediaHeight: asset.height ?? row.input.height, mimeType: asset.mimeType, size: asset.sizeBytes,
        sourceAnimation: { spaceId: row.spaceId, executionId: row.source.executionId, videoUrl: asset.fileUrl },
      },
      onReceipt: () => fire({ type: 'receipt' }),
    }).then((outcome) => {
      if (outcome.status === 'unreachable') fire({ type: 'sync_timeout' });
      else if (outcome.status === 'refused') { fire({ type: 'synced' }); fire({ type: 'size_refused' }); }
      else { fire({ type: 'synced' }); fire({ type: 'written', nodeId: outcome.nodeId }); }
    }, () => fire({ type: 'sync_timeout' }));
  }, [asset, controls.data, fire, projectId, row, userId]);
  if (canvases.length === 0) {
    return <BarButton testId='motion-action-place-on-canvas' label={t('spaces.webAnimation.noCanvas')} icon={<LayoutGrid className='size-4' />} disabled />;
  }
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <BarButton testId='motion-action-place-on-canvas' label={t('spaces.webAnimation.placeOnCanvas')} icon={<LayoutGrid className='size-4' />}
        loading={placement.status !== 'idle'} disabled={asset === undefined} />
    </PopoverTrigger>
    <PopoverContent side='top' align='start' sideOffset={8} className='flex w-52 flex-col p-1'>
      <span className='px-2 py-1 text-xs text-muted-foreground'>{t('spaces.webAnimation.chooseCanvas')}</span>
      {canvases.map((canvas) => <Button key={canvas.id} type='button' variant={null} size={null} data-testid={`motion-canvas-${canvas.id}`} onClick={() => choose(canvas)}
        className='rounded-chrome-sm px-2 py-1.5 text-left text-sm hover-enabled:bg-accent'>{canvas.name}</Button>)}
    </PopoverContent>
  </Popover>;
}

/** The details popover's props. */
interface DetailsProps {
  row: WebAnimationRowView;
  unresolvedOnBase: number;
  readOnly: boolean;
  onCancel: (row: WebAnimationRowView) => void;
  onOpen: (executionId: string) => void;
}

/**
 * The current result's details (#1490 design §7.1): its title, request or source, steps, usage, the result it was
 * modified from with that result's open annotations, why it failed, and Cancel while it runs.
 * @param props - The row and what the details offer.
 * @param props.row - The row.
 * @param props.unresolvedOnBase - Open annotations on the result a modification started from.
 * @param props.readOnly - Whether the user may act.
 * @param props.onCancel - Cancels it.
 * @param props.onOpen - Opens another result.
 * @returns The popover.
 * @throws {never} Never.
 */
function Details({ row, unresolvedOnBase, readOnly, onCancel, onOpen }: DetailsProps): React.JSX.Element {
  const t = useTranslation();
  const cancelling = useRunning(cancelIntent(row.id)) !== undefined;
  const unfinished = !webAnimationExecutionEnded(row.status);
  const cancel = React.useCallback((): void => onCancel(row), [onCancel, row]);
  const base = row.kind === 'web_animation_modify' ? row.base : null;
  const openBase = React.useCallback((): void => { if (base !== null) onOpen(base.executionId); }, [base, onOpen]);
  return <Popover>
    <PopoverTrigger asChild>
      <BarButton testId='motion-details' label={t('spaces.webAnimation.details')} icon={<Ellipsis className='size-4' />} />
    </PopoverTrigger>
    <PopoverContent side='top' align='end' sideOffset={8} className='flex w-80 flex-col gap-2 p-3 text-xs'>
      <span className='break-words font-medium'>{rowTitle(row, t)}</span>
      <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
        <dt className='text-muted-foreground'>{t('spaces.webAnimation.statusLabel')}</dt>
        <dd>{t(`timeline.webAnimation.status.${row.status}`)}</dd>
        <dt className='text-muted-foreground'>{t(row.kind === 'web_animation_export' ? 'spaces.webAnimation.sourceLabel' : row.kind === 'web_animation_modify' ? 'spaces.webAnimation.dialog.instruction' : 'timeline.webAnimation.dialog.prompt')}</dt>
        <dd className='min-w-0 break-words'>{row.kind === 'web_animation_export' ? requestTitle(row.source, t) : row.request}</dd>
        <dt className='text-muted-foreground'>{t('timeline.webAnimation.usageLabel')}</dt>
        <dd className={cn(unfinished && 'text-muted-foreground')}>
          {unfinished ? t('timeline.webAnimation.usagePending') : t('timeline.webAnimation.usage', { credits: formatCredits(row.usageCredits, getLocale()) })}
        </dd>
        {base !== null && <>
          <dt className='text-muted-foreground'>{t('spaces.webAnimation.modifiedFromLabel')}</dt>
          <dd><Button type='button' variant={null} size={null} className='text-left underline' onClick={openBase}>
            {unresolvedOnBase > 0 ? t('spaces.webAnimation.baseWithAnnotations', { base: base.request, count: unresolvedOnBase }) : base.request}
          </Button></dd>
        </>}
      </dl>
      <ol className='flex flex-col gap-1'>
        {executionStepKeys(row.kind).map((key, index) => {
          const mark = stepMark(row, index);
          const failedHere = mark === 'stopped' && row.status !== 'cancelled';
          return <li key={key} data-mark={mark} className={cn('flex items-center gap-2', failedHere && 'text-status-error-foreground', (mark === 'pending' || (mark === 'stopped' && !failedHere)) && 'text-muted-foreground')}>
            {mark === 'done' ? <Check className='size-3.5 shrink-0' /> : mark === 'current' ? <LoaderCircle className='size-3.5 shrink-0 animate-spin' />
              : mark === 'stopped' ? (failedHere ? <X className='size-3.5 shrink-0' /> : <CircleSlash className='size-3.5 shrink-0' />) : <Dot className='size-3.5 shrink-0' />}
            {t(key)}
          </li>;
        })}
      </ol>
      {row.status === 'failed' && <p className='text-status-error-foreground'>{t(failureSentenceKey(row.failureReason))}</p>}
      {unfinished && !readOnly && row.ownProject && row.status !== 'cancelling' && <Button type='button' data-testid='motion-cancel' variant='outline' size='sm' className='self-start'
        loading={cancelling} onClick={cancel} icon={<X className='size-4' />}>{t('timeline.webAnimation.cancel')}</Button>}
      {unfinished && !row.ownProject && <span className='text-muted-foreground'>{t('spaces.webAnimation.foreignCancel')}</span>}
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
  const limits = useTimelineLimits(projectId)?.webAnimation;
  const lists = useMotionLists(projectId, spaceId, limits?.sourceRefreshIntervalMs);
  const spaces = useProjectSpaceList(projectId);
  const canvases = React.useMemo(() => spaces.filter((space) => space.type === 'canvas')
    .map((space, index) => ({ space, index }))
    .sort((a, b) => (a.space.createdAt ?? 0) - (b.space.createdAt ?? 0) || a.index - b.index)
    .map(({ space }) => space), [spaces]);
  const connection = useSpaceConnection();
  const doc = React.useMemo(() => getDoc(docName.webAnimationSpace(projectId, spaceId)), [projectId, spaceId]);
  const readWho = React.useCallback(() => ({ role: myRole, viewerId }), [myRole, viewerId]);
  const store = React.useMemo(() => webAnimationAnnotationStore({ doc, readWho }), [doc, readWho]);
  const threads = useThreads(store);
  const docReady = connection.hasEverSynced;
  const annotationsWritable = !readOnly && docReady && connection.writeAccess !== 'denied';

  // Panels and selection (design §13.2, §13.8).
  const [panels, dispatchPanels] = React.useReducer(transitionMotionPanels, MOTION_PANELS_CLOSED);
  const panelsEvent = React.useCallback((event: MotionPanelsEvent): void => dispatchPanels(event), []);
  const [selection, setSelection] = React.useState<SelectionState>(SELECTION_NONE);
  const selectionRef = React.useRef(selection);
  const [fetched, setFetched] = React.useState<ReadonlyMap<string, WebAnimationRowView>>(() => new Map());
  const requestSeq = React.useRef(0);
  const select = React.useCallback((event: SelectionEvent): void => {
    const { state, effects } = transitionWebAnimationSelection(selectionRef.current, event);
    selectionRef.current = state;
    setSelection(state);
    for (const effect of effects) {
      if (effect.type === 'show_tab') dispatchPanels({ type: 'show_tab', tab: effect.tab });
      if (effect.type === 'toast_not_found') toast.warning(t('spaces.webAnimation.notFound'));
      if (effect.type === 'fetch') {
        timelineApi.getExecution(projectId, spaceId, effect.executionId).then((row) => {
          setFetched((current) => new Map(current).set(row.id, row));
          select({ type: 'fetched', requestId: effect.requestId, row });
        }, () => select({ type: 'fetch_failed', requestId: effect.requestId }));
      }
    }
  }, [projectId, spaceId, t]);
  const rowById = React.useCallback((id: string): WebAnimationRowView | undefined => lists.byId.get(id) ?? fetched.get(id), [lists.byId, fetched]);
  const selectedId = selection.status === 'selected' ? selection.executionId : null;
  const row = selectedId === null ? undefined : rowById(selectedId);
  const locate = React.useCallback((executionId: string): void => {
    requestSeq.current += 1;
    select({ type: 'locate', executionId, loaded: rowById(executionId) !== undefined, requestId: requestSeq.current });
  }, [rowById, select]);
  const pick = React.useCallback((id: string): void => select({ type: 'pick', executionId: id }), [select]);

  // The newest finished result opens once the list arrives, unless something else was asked for.
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (opened.current || !lists.done.own.isSuccess || selectionRef.current.status !== 'none') return;
    opened.current = true;
    const newest = rowsOf(lists.done.own)[0] ?? rowsOf(lists.done.legacy)[0];
    if (newest !== undefined) pick(newest.id);
  }, [lists.done.own, lists.done.legacy, pick]);
  // A row's status crossing into the other tab moves the tab with it.
  const status = row?.status;
  React.useEffect(() => {
    if (selectedId !== null && status !== undefined) select({ type: 'row_changed', row: { id: selectedId, status } });
  }, [selectedId, status, select]);

  // An open request aimed at this Space (design §8.5): select its execution, then say it was handled.
  const openRequest = useSpaceOpenRequestStore((state) => state.state);
  React.useEffect(() => {
    if (openRequest.status !== 'opened' || openRequest.spaceId !== spaceId) return;
    opened.current = true;
    if (openRequest.request.select !== undefined) {
      locate(openRequest.request.select);
      dispatchPanels({ type: 'locate' });
    }
    useSpaceOpenRequestStore.getState().dispatch({ type: 'handled' });
  }, [openRequest, spaceId, locate]);

  // Esc closes the open panel.
  React.useEffect(() => {
    /**
     * Close the panel on Esc.
     * @param event - The key.
     */
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') dispatchPanels({ type: 'escape' }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Playback over the shown result.
  const durationSeconds = row === undefined ? 0 : rowSeconds(row);
  const clock = useMotionClock(row?.status === 'succeeded' ? durationSeconds : 0, selectedId);
  const { pause: pauseClock } = clock;
  const fps = row === undefined ? { num: 24, den: 1 } : row.input.fps;
  const frame = Math.min(Math.round(clock.time * fps.num / fps.den), Math.max(0, Math.round(durationSeconds * fps.num / fps.den) - 1));

  // Running, accepting and cancelling (design §4.2).
  const refresh = React.useCallback((): void => { void queryClient.invalidateQueries({ queryKey: spaceTasksQueryKey(projectId, spaceId) }); }, [queryClient, projectId, spaceId]);
  const accept = React.useCallback((request: WebAnimationAcceptRequest, actionId: string, onRefused?: (message: string) => void): void => {
    void runOnce(`web-animation-execution:${spaceId}:${actionId}`, {
      scope: 'timeline-execution',
      prepare: () => ({ ...request, projectId, spaceId, actionId } as WebAnimationAcceptBody),
      send: (key, body) => timelineApi.acceptExecution(body, key),
    }).then((outcome) => {
      if (outcome.kind === 'released') return;
      if (outcome.kind === 'failed') {
        const message = serverMessage(outcome.error, t('common.runOnce.unknownResult'));
        if (onRefused === undefined) toast.error(message); else onRefused(message);
        return;
      }
      const { row: accepted, created } = outcome.result;
      setFetched((current) => new Map(current).set(accepted.id, accepted));
      select({ type: 'accepted', created, row: accepted });
      dispatchPanels({ type: 'accepted', created, tab: created || !webAnimationExecutionEnded(accepted.status) ? 'running' : 'done' });
      refresh();
      if (created) dispatchDraft({ type: 'accepted', executionId: accepted.id });
    });
  }, [projectId, spaceId, select, refresh, t]);
  const cancel = React.useCallback((target: WebAnimationRowView): void => {
    if (readOnly) return;
    void runOnce(cancelIntent(target.id), {
      scope: 'timeline-execution',
      prepare: () => target.id,
      send: (key, id) => timelineApi.cancelExecution(id, projectId, key),
      onDone: () => { refresh(); return undefined; },
      onFailure: (err) => { toast.error(serverMessage(err, t('common.runOnce.unknownResult'))); },
    });
  }, [readOnly, projectId, refresh, t]);

  // New and Modify (design §5.1).
  const [draft, dispatchDraft] = React.useReducer(transitionCreationDraft, CLOSED_DRAFT);
  const [retryDialog, setRetryDialog] = React.useState(false);
  const openDialog = React.useCallback((input: Partial<CreationDraftInput>, retry = false): void => {
    if (readOnly || limits === undefined) return;
    const aspect = limits.aspects.find((value): value is CreationDraftInput['aspect'] => value === '16:9' || value === '9:16' || value === '1:1') ?? '16:9';
    setRetryDialog(retry);
    dispatchPanels({ type: 'new' });
    dispatchDraft({ type: 'open', input: { base: null, prompt: '', engine: DEFAULT_WEB_ANIMATION_ENGINE, aspect, durationSeconds: limits.durationSeconds.default, ...input } });
  }, [readOnly, limits]);
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
    actionId, (error) => dispatchDraft({ type: 'refused', error }));
  }, [draft, readOnly, accept]);

  // The shown result's actions (design §7.2).
  const modify = React.useCallback((): void => {
    if (!playable(row)) return;
    openDialog({ base: { sourceVersionId: row.resultSourceVersionId, request: row.request }, aspect: row.input.aspect, durationSeconds: row.input.durationSeconds });
  }, [row, openDialog]);
  const exportVideo = React.useCallback((): void => {
    if (playable(row)) accept({ kind: 'web_animation_export', sourceVersionId: row.resultSourceVersionId }, newId());
  }, [row, accept]);
  const retry = React.useCallback((): void => {
    if (row === undefined) return;
    if (row.kind === 'web_animation_export') { accept({ kind: 'web_animation_export', sourceVersionId: row.input.sourceVersionId }, newId()); return; }
    const base = row.kind === 'web_animation_modify' ? { sourceVersionId: row.input.baseSourceVersionId, request: row.base.request } : null;
    openDialog({ base, prompt: row.request, aspect: row.input.aspect, durationSeconds: row.input.durationSeconds }, true);
  }, [row, accept, openDialog]);
  const exportRow = row !== undefined && row.kind !== 'web_animation_export' ? row.export ?? null : null;
  const viewVideo = React.useCallback((): void => { if (exportRow !== null) locate(exportRow.executionId); }, [exportRow, locate]);
  const viewSource = React.useCallback((): void => { if (row?.kind === 'web_animation_export') locate(row.source.executionId); }, [row, locate]);
  const exportAsset = useTimelineAsset(projectId, row?.kind === 'web_animation_export' ? row.resultAssetId ?? '' : '').data;
  const download = React.useCallback((): void => { if (exportAsset !== undefined) downloadAsset(exportAsset.fileUrl); }, [exportAsset]);

  // Annotations (design §10).
  const resultThreads = React.useMemo(() => threads.flatMap((thread) => {
    const anchor = readWebAnimationAnchor(thread.metadata);
    return thread.deletedAt === undefined && anchor !== null && anchor.executionId === selectedId ? [{ thread, anchor }] : [];
  }), [threads, selectedId]);
  const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null);
  const activeThread = React.useMemo(() => {
    const thread = threads.find((item) => item.id === activeThreadId && item.deletedAt === undefined);
    const anchor = thread === undefined ? null : readWebAnimationAnchor(thread.metadata);
    return thread === undefined || anchor === null ? null : { thread, anchor };
  }, [threads, activeThreadId]);
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
        store.createThread({ initialComment: { body: asCommentBody(effect.text.trim()) as never }, metadata: { webAnimationAnchor: effect.anchor } }).then((thread) => {
          annotate({ type: 'written' });
          setActiveThreadId(thread.id);
        }, (err: unknown) => annotate({ type: 'write_failed', reason: err instanceof SpaceFullError ? 'space_full' : 'failed' }));
      }
    }
  }, [pauseClock, store, t]);
  React.useEffect(() => { annotate(docReady ? { type: 'reconnect' } : { type: 'disconnect' }); }, [docReady, annotate]);
  const addAnnotation = React.useCallback((): void => {
    if (selectedId !== null) {
      setActiveThreadId(null);
      annotate({ type: 'add', executionId: selectedId, timeSeconds: clock.time });
    }
  }, [selectedId, clock.time, annotate]);
  const clickFrame = React.useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    if (annotationRef.current.status !== 'picking' && annotationRef.current.status !== 'writing') return;
    const box = event.currentTarget.getBoundingClientRect();
    const point: FramePoint = { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
    annotate({ type: 'click_frame', point });
  }, [annotate]);
  const keepWriting = React.useCallback((open: boolean): void => { if (!open) setDiscardAsked(null); }, []);
  const discard = React.useCallback((): void => {
    const asked = discardAsked;
    setDiscardAsked(null);
    if (asked !== null) annotate({ type: asked, confirmed: true });
  }, [discardAsked, annotate]);
  const typeAnnotation = React.useCallback((text: string): void => annotate({ type: 'type', text }), [annotate]);
  const sendAnnotation = React.useCallback((): void => annotate({ type: 'send' }), [annotate]);
  const cancelAnnotation = React.useCallback((): void => annotate({ type: 'cancel', confirmed: false }), [annotate]);
  const openThread = React.useCallback((threadId: string): void => {
    const thread = threads.find((item) => item.id === threadId);
    const anchor = thread === undefined ? null : readWebAnimationAnchor(thread.metadata);
    if (anchor === null) return;
    annotate({ type: 'switch_result', confirmed: false });
    if (annotationRef.current.status !== 'idle') return;
    setActiveThreadId(threadId);
    if (anchor.executionId !== selectedId) locate(anchor.executionId);
    pendingSeek.current = anchor.timeSeconds;
  }, [threads, selectedId, locate, annotate]);
  const pendingSeek = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (pendingSeek.current === null || activeThread === null || activeThread.anchor.executionId !== selectedId) return;
    clock.seek(pendingSeek.current);
    pendingSeek.current = null;
  }, [activeThread, selectedId, clock]);
  const openMarker = React.useCallback((threadId: string): void => {
    dispatchPanels({ type: 'marker', threadId });
    openThread(threadId);
  }, [openThread]);
  const closeThread = React.useCallback((): void => setActiveThreadId(null), []);
  const pickRow = React.useCallback((id: string): void => {
    annotate({ type: 'switch_result', confirmed: false });
    if (annotationRef.current.status !== 'idle') return;
    setActiveThreadId(null);
    pick(id);
  }, [annotate, pick]);
  const order = React.useMemo(() => [...rowsOf(lists.done.own), ...rowsOf(lists.done.legacy)].map((item) => item.id), [lists.done.own, lists.done.legacy]);
  const unresolvedOnBase = row?.kind === 'web_animation_modify'
    ? threads.filter((thread) => !thread.resolved && thread.deletedAt === undefined && readWebAnimationAnchor(thread.metadata)?.executionId === row.base.executionId).length : 0;

  const toggleExecutions = React.useCallback((): void => panelsEvent({ type: 'toggle_executions' }), [panelsEvent]);
  const toggleAnnotations = React.useCallback((): void => panelsEvent({ type: 'toggle_annotations' }), [panelsEvent]);
  const closePanel = React.useCallback((): void => panelsEvent({ type: 'escape' }), [panelsEvent]);
  const pickTab = React.useCallback((tab: MotionTab): void => panelsEvent({ type: 'pick_tab', tab }), [panelsEvent]);
  const seekTo = React.useCallback((value: number[]): void => clock.seek(value[0] ?? 0), [clock]);
  const seekValue = React.useMemo(() => [clock.time], [clock.time]);
  const finished = row?.status === 'succeeded';
  const failed = row !== undefined && webAnimationExecutionFailed(row.status);
  const unresolvedCount = threads.filter((thread) => !thread.resolved && thread.deletedAt === undefined).length;
  const panelOpen = panels.panel !== 'none';
  const frameStyle = React.useMemo(() => {
    const ratio = row === undefined ? 16 / 9 : ratioOf(row);
    return { aspectRatio: `${ratio}`, width: `min(100cqw, calc(100cqh * ${ratio}))` };
  }, [row]);
  const draftPoint = annotation.status === 'writing' ? annotation.point : null;
  /**
   * Where a card sits over the frame: beside its point, or at the bottom of the frame without one.
   * @param point - The point, or null.
   * @returns Its position.
   */
  const cardStyle = (point: FramePoint | null): React.CSSProperties => (point === null
    ? { left: '50%', bottom: 8, transform: 'translateX(-50%)' }
    : { left: `calc(${point.x * 100}% + 14px)`, top: `calc(${point.y * 100}% - 12px)` });

  return <div data-testid='motion-space' className='relative h-full overflow-hidden bg-muted'>
    {panels.panel === 'executions' && <MotionExecutionsPanel lists={lists} tab={panels.tab} selectedId={selectedId} onTab={pickTab} onPick={pickRow} onClose={closePanel} />}
    {panels.panel === 'annotations' && <MotionAnnotationsPanel threads={threads} order={order} rows={lists.byId} activeThreadId={activeThreadId} onOpen={openThread} onClose={closePanel} />}
    <div className={cn('absolute bottom-[4.5rem] left-6 top-6 flex items-center justify-center', panelOpen ? 'right-[22rem]' : 'right-6')} style={{ containerType: 'size' }}>
      {row === undefined
        ? selection.status === 'fetching' || !lists.done.own.isSuccess
          ? <LoaderCircle data-testid='motion-loading' className='size-5 animate-spin text-muted-foreground' />
          : <div data-testid='motion-empty' className='flex flex-col items-center gap-3 text-sm text-muted-foreground'>
            <span>{t('spaces.webAnimation.empty')}</span>
            {!readOnly && <Button data-testid='motion-empty-new' size='sm' onClick={openNew} icon={<Plus className='size-4' />}>{t('spaces.webAnimation.new')}</Button>}
          </div>
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a point on the frame is marked with the mouse only
        : <div data-testid='motion-preview' data-execution-id={row.id} className={cn('relative', annotation.status === 'picking' && 'cursor-crosshair')} style={frameStyle} onClick={clickFrame}>
          {finished && playable(row) && <MotionResultPlayer projectId={projectId} executionId={row.id} sourceVersionId={row.resultSourceVersionId} input={row.input} frame={frame} />}
          {finished && row.kind === 'web_animation_export' && <ExportVideo url={exportAsset?.fileUrl ?? null} time={clock.time} playing={clock.playing} />}
          {!finished && <div className='flex size-full flex-col items-center justify-center gap-2 rounded-chrome border border-dashed border-border bg-card text-xs text-muted-foreground'>
            {failed
              ? <span className='text-status-error-foreground'>{row.status === 'failed' ? t(failureSentenceKey(row.failureReason)) : t(`timeline.webAnimation.status.${row.status}`)}</span>
              : <span className='flex items-center gap-1.5'><LoaderCircle className='size-3.5 animate-spin' />
                {`${t(`timeline.webAnimation.status.${row.status}`)}${row.phase !== null ? ` · ${t(phaseKey(row.kind, row.phase))}` : ''}`}</span>}
            {failed && !readOnly && <Button data-testid='motion-retry' variant='outline' size='sm' onClick={retry} icon={<RotateCcw className='size-4' />}>
              {t(row.kind === 'web_animation_export' ? 'spaces.webAnimation.reexport' : 'timeline.webAnimation.retry')}</Button>}
          </div>}
          {finished && playable(row) && resultThreads.filter(({ anchor }) => anchor.point !== null && Math.abs(anchor.timeSeconds - clock.time) < PIN_WINDOW_SECONDS).map(({ thread, anchor }) =>
            <Button key={thread.id} type='button' variant={null} size={null} data-testid={`motion-pin-${thread.id}`} aria-label={t('spaces.webAnimation.annotations')}
              onClick={(event) => { event.stopPropagation(); openThread(thread.id); }}
              className={cn('absolute size-5 -translate-x-1/2 -translate-y-full rounded-full rounded-bl-none border border-background', thread.resolved ? 'bg-muted-foreground' : 'bg-status-selected')}
              style={{ left: `${(anchor.point?.x ?? 0) * 100}%`, top: `${(anchor.point?.y ?? 0) * 100}%` }} />)}
          {annotation.status === 'picking' && <div className='pointer-events-none absolute inset-x-0 top-2 flex justify-center'>
            <span className='rounded-full bg-popover px-3 py-1 text-xs text-popover-foreground shadow-md'>{t('spaces.webAnimation.pickPoint')}</span></div>}
          {draftPoint !== null && <span className='pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-status-selected'
            style={{ left: `${draftPoint.x * 100}%`, top: `${draftPoint.y * 100}%` }} />}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the click is only kept from the frame */}
          {(annotation.status === 'picking' || annotation.status === 'writing' || annotation.status === 'sending') && <div data-testid='motion-annotation-draft'
            className='absolute z-20 w-72 rounded-chrome border border-border bg-card p-3 shadow-md' style={cardStyle(draftPoint)} onClick={(event) => event.stopPropagation()}>
            <span className='mb-2 block text-2xs text-muted-foreground'>{t('spaces.webAnimation.annotateAt', { time: formatAnnotationTime(annotation.timeSeconds) })}</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the box the user just asked for by pressing Add annotation; they expect to type immediately */}
            <DocumentCommentWriteBox name='motion-annotation' autoFocus value={annotation.status === 'picking' ? '' : annotation.text} placeholder={t('spaces.webAnimation.annotationPlaceholder')}
              onChange={typeAnnotation} onSave={sendAnnotation} onCancel={cancelAnnotation} />
          </div>}
          {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the click is only kept from the frame */}
          {activeThread !== null && activeThread.anchor.executionId === row.id && annotation.status === 'idle' && <div className='absolute z-20' style={cardStyle(activeThread.anchor.point)} onClick={(event) => event.stopPropagation()}>
            <div className='relative'>
              <MotionThreadCard thread={activeThread.thread} timeSeconds={activeThread.anchor.timeSeconds} store={store} myRole={myRole} viewerId={viewerId} canWrite={annotationsWritable} />
              <Button type='button' variant='ghost' size='compact' className='absolute right-1 top-1 px-1' aria-label={t('spaces.webAnimation.closePanel')} onClick={closeThread} icon={<X className='size-4' />} />
            </div>
          </div>}
        </div>}
    </div>
    <div data-testid='motion-bottom-bar' className='absolute inset-x-3 bottom-3 z-10 flex h-12 items-center gap-1 rounded-chrome border border-border bg-card px-2 shadow-md'>
      <BarButton testId='motion-play' label={t(clock.playing ? 'timeline.pause' : 'timeline.play')} icon={clock.playing ? <Pause className='size-4' /> : <Play className='size-4' />}
        onClick={clock.toggle} disabled={!finished} />
      <span className='mx-2 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground'>
        {row === undefined ? '—' : `${formatAnnotationTime(clock.time)} / ${formatAnnotationTime(durationSeconds)}`}
      </span>
      <div className='relative mr-2 flex h-8 min-w-24 flex-1 items-center'>
        <Slider aria-label={t('timeline.seek')} value={seekValue} onValueChange={seekTo} min={0} max={Math.max(0.01, durationSeconds)} step={0.01} disabled={!finished} className='w-full' />
        {finished && playable(row) && docReady && resultThreads.map(({ thread, anchor }) => <Button key={thread.id} type='button' variant={null} size={null} data-testid={`motion-marker-${thread.id}`}
          aria-label={bodyPreview(thread)} title={undefined} onClick={() => openMarker(thread.id)}
          className={cn('absolute top-0 h-2.5 w-1.5 -translate-x-1/2 rounded-sm', thread.resolved ? 'bg-muted-foreground' : 'bg-status-selected')}
          style={{ left: `${(anchor.timeSeconds / Math.max(0.01, durationSeconds)) * 100}%` }} />)}
      </div>
      {row !== undefined && <>
        <Separator orientation='vertical' className='mx-1 h-5' />
        {finished && row.kind !== 'web_animation_export' && <>
          {!readOnly && <BarButton testId='motion-action-add-annotation' label={t('spaces.webAnimation.addAnnotation')} icon={<MessageSquarePlus className='size-4' />}
            pressed={annotation.status !== 'idle'} onClick={addAnnotation} disabled={!annotationsWritable} loading={!docReady} />}
          {!readOnly && <BarButton testId='motion-action-modify' label={t('spaces.webAnimation.modify')} icon={<Pencil className='size-4' />} onClick={modify} />}
          {exportRow !== null
            ? <BarButton testId='motion-action-view-video' label={t('spaces.webAnimation.viewVideo')} icon={<Video className='size-4' />} onClick={viewVideo} />
            : !readOnly && <BarButton testId='motion-action-export' label={t('spaces.webAnimation.export')} icon={<Upload className='size-4' />} onClick={exportVideo} />}
        </>}
        {finished && row.kind === 'web_animation_export' && <>
          <BarButton testId='motion-action-download' label={t('spaces.webAnimation.download')} icon={<Download className='size-4' />} onClick={download} disabled={exportAsset === undefined} />
          {!readOnly && <PlaceOnCanvas projectId={projectId} row={row} canvases={canvases} />}
          <BarButton testId='motion-action-view-source' label={t('spaces.webAnimation.viewSource')} icon={<Undo2 className='size-4' />} onClick={viewSource} />
        </>}
        <Details row={row} unresolvedOnBase={unresolvedOnBase} readOnly={readOnly} onCancel={cancel} onOpen={locate} />
      </>}
      <Separator orientation='vertical' className='mx-1 h-5' />
      <BarButton testId='motion-open-executions' label={t('spaces.webAnimation.executions')} icon={<List className='size-4' />} pressed={panels.panel === 'executions'}
        count={lists.totals.inProgress} onClick={toggleExecutions} />
      <BarButton testId='motion-open-annotations' label={t('spaces.webAnimation.annotations')} icon={<MessageSquare className='size-4' />} pressed={panels.panel === 'annotations'}
        count={docReady ? unresolvedCount : 0} onClick={toggleAnnotations} loading={!docReady} />
      {!readOnly && <BarButton testId='motion-new' label={t('spaces.webAnimation.new')} icon={<Plus className='size-4' />} onClick={openNew} />}
    </div>
    <AlertDialog open={discardAsked !== null} onOpenChange={keepWriting}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('spaces.webAnimation.discardAnnotation')}</AlertDialogTitle></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('spaces.webAnimation.keepWriting')}</AlertDialogCancel>
          <AlertDialogAction data-testid='motion-discard-annotation' onClick={discard}>{t('spaces.webAnimation.discard')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {draft.status !== 'closed' && draft.open && limits !== undefined && <WebAnimationDialog spaceId={spaceId} draft={draft} retry={retryDialog} limits={limits}
      onEdit={editDraft} onExecute={execute} onClose={closeDraft} />}
  </div>;
}

/**
 * A thread's first comment, as its marker's name.
 * @param thread - The thread.
 * @returns The text.
 * @throws {never} Never.
 */
function bodyPreview(thread: ThreadData): string {
  const first = thread.comments.find((comment) => comment.deletedAt === undefined);
  return first === undefined ? '' : bodyText(first.body);
}

/** An exported video, driven by the play bar. */
interface ExportVideoProps { url: string | null; time: number; playing: boolean }

/**
 * An exported video in the preview, kept on the play bar's time; its own controls are not drawn.
 * @param props - The video and the clock.
 * @param props.url - The video's address, once resolved.
 * @param props.time - The play bar's time.
 * @param props.playing - Whether the play bar plays.
 * @returns The video.
 * @throws {never} Never.
 */
function ExportVideo({ url, time, playing }: ExportVideoProps): React.JSX.Element {
  const video = React.useRef<HTMLVideoElement>(null);
  React.useEffect(() => {
    const element = video.current;
    if (element === null) return;
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [playing]);
  React.useEffect(() => {
    const element = video.current;
    if (element !== null && !playing && Math.abs(element.currentTime - time) > 0.05) element.currentTime = time;
  }, [time, playing]);
  return url === null ? <div className='size-full rounded-chrome bg-card' /> : <video ref={video} src={url} muted playsInline preload='auto' className='size-full rounded-chrome bg-black object-contain' />;
}
