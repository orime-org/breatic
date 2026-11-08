// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Crosshair, ListFilter, Sparkles, Upload } from 'lucide-react';
import type { SceneGenerationOrigin } from '@breatic/shared';
import { checkSpaceTask, isGenerationTask, listSpaceTasks, removeSpaceTask, spaceTasksQueryKey, type SpaceTask } from '@web/data/api/scene';
import { ApiException } from '@web/data/api/types';
import { Button } from '@web/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Skeleton } from '@web/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { KindBadge } from '@web/spaces/canvas/_shared/KindBadge';
import { failureSentence } from '@web/spaces/canvas/failure-sentence';
import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import type { SceneUploads } from '@web/spaces/three-d/scene-uploads';

interface SceneTaskListProps {
  projectId: string;
  spaceId: string;
  userId: string;
  canEdit: boolean;
  /** Whether the user may generate in this project: a generation row's Retry and Remove are server calls that never touch the scene. */
  canGenerate: boolean;
  /** The page's own uploads: live percent, registration and which rows it may retry. */
  uploads: SceneUploads;
  /** Other pages' whole-percent progress, by task row. */
  remoteUploads: Readonly<Record<string, number>>;
  /** Place a finished model into the scene; resolves once placed or refused. */
  onPlace: (task: SpaceTask) => Promise<void>;
  /** The row a just-started upload or generation opened, which takes focus once listed. */
  focusTaskId?: string | null;
  /** Called once the handed row has taken focus. */
  onFocused?: () => void;
  /** Opens the generation dialog filled from a generation row (inner#1691 design 4.6). */
  onRetryGeneration?: (task: SpaceTask) => void;
  /** The models the scene holds objects of, by asset. */
  placedAssetIds?: ReadonlySet<string>;
  /** Selects the scene's objects of one model. */
  onLocate?: (assetId: string) => void;
  /** Where the filter menu is drawn, such as the panel's title bar; inline above the rows when absent. */
  filterHost?: HTMLElement | null;
}

/** The list's own filters, which live on this page only (design 7.3). */
interface TaskFilters {
  running: boolean;
  kind: 'all' | 'import' | 'generation';
  starter: 'all' | 'me';
  origin: 'all' | SceneGenerationOrigin;
}

const NO_FILTERS: TaskFilters = { running: false, kind: 'all', starter: 'all', origin: 'all' };
const MINUTE_MS = 60_000;
const DOT_CLASS: Record<SpaceTask['status'], string> = {
  running: 'bg-status-info',
  done: 'bg-status-success',
  failed: 'bg-status-error',
  expired: 'bg-status-warning',
};

/**
 * Whether a row passes the filters.
 * @param task - The row.
 * @param filters - The filters set.
 * @param userId - Who reads.
 * @returns True when every filter set lets it through.
 */
function passes(task: SpaceTask, filters: TaskFilters, userId: string): boolean {
  const generation = isGenerationTask(task);
  if (filters.running && task.status !== 'running') return false;
  if (filters.kind !== 'all' && filters.kind !== (generation ? 'generation' : 'import')) return false;
  if (filters.starter === 'me' && task.startedByUserId !== userId) return false;
  if (filters.origin !== 'all' && (!generation || task.origin !== filters.origin)) return false;
  return true;
}

/**
 * The 3D Space's task list (inner#1690, inner#1691): every member's model
 * imports and 3D generations, and the finished ones placed into the scene
 * from here.
 *
 * The rows are the server's; this page adds what only it knows about the
 * uploads it sends, and its own filters. The list is read again when the
 * server signals a change (the page invalidates its query) and when the
 * earliest running row reaches its deadline, timed from the server's clock so
 * a browser clock that runs ahead cannot reread in a loop.
 * @param props - Space identity, edit right, the page's uploads and the row actions.
 * @returns The list.
 */
export const SceneTaskList = React.memo(function SceneTaskList({ projectId, spaceId, userId, canEdit, canGenerate, uploads, remoteUploads, onPlace, focusTaskId, onFocused,
  onRetryGeneration, placedAssetIds, onLocate, filterHost }: SceneTaskListProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(() => spaceTasksQueryKey(projectId, spaceId), [projectId, spaceId]);
  const query = useQuery({ queryKey, queryFn: ({ signal }) => listSpaceTasks(projectId, spaceId, signal) });
  React.useSyncExternalStore(uploads.subscribe, uploads.getVersion);
  const names = useCollaboratorNames();
  const [placing, setPlacing] = React.useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = React.useState<ReadonlySet<string>>(new Set());
  const [checking, setChecking] = React.useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = React.useState<TaskFilters>(NO_FILTERS);
  const [, setMinute] = React.useState(0);
  const data = query.data;

  React.useEffect(() => {
    if (data) uploads.reconcile(spaceId, data.tasks);
  }, [data, uploads, spaceId]);

  const list = React.useRef<HTMLDivElement>(null);
  const reread = React.useRef<string | null>(null);
  React.useEffect(() => {
    // A row this page just opened and the list does not hold yet: read it again, whether or not the change signal arrives.
    if (!focusTaskId || !data || reread.current === focusTaskId || data.tasks.some((task) => task.id === focusTaskId)) return;
    reread.current = focusTaskId;
    void queryClient.invalidateQueries({ queryKey });
  }, [focusTaskId, data, queryClient, queryKey]);
  React.useEffect(() => {
    if (!focusTaskId) return;
    // The row the user just made shows whatever the page's filters say.
    const handed = data?.tasks.find((task) => task.id === focusTaskId);
    if (handed !== undefined && !passes(handed, filters, userId)) {
      setFilters(NO_FILTERS);
      return;
    }
    const target = list.current?.querySelector<HTMLElement>(`[data-testid="scene-task-${focusTaskId}"]`);
    if (!target) return;
    target.focus();
    onFocused?.();
  }, [focusTaskId, data, filters, userId, onFocused]);

  React.useEffect(() => {
    if (!data) return;
    const serverNow = Date.parse(data.serverNow);
    const waits = data.tasks.filter((task) => task.status === 'running').map((task) => Date.parse(task.deadlineAt) - serverNow);
    if (waits.length === 0) return;
    const timer = setTimeout(() => { void queryClient.invalidateQueries({ queryKey }); }, Math.max(0, Math.min(...waits)));
    return (): void => clearTimeout(timer);
  }, [data, queryClient, queryKey]);

  const anyRunning = data?.tasks.some((task) => task.status === 'running') ?? false;
  React.useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setMinute((value) => value + 1), MINUTE_MS);
    return (): void => clearInterval(timer);
  }, [anyRunning]);

  /**
   * Run one row's action while its button waits.
   * @param id - The row.
   * @param setBusy - Which waiting set the row joins.
   * @param action - The action.
   */
  const busyWhile = React.useCallback(async (id: string, setBusy: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, action: () => Promise<void>): Promise<void> => {
    setBusy((previous) => new Set(previous).add(id));
    try {
      await action();
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const removeFailed = t('spaces.threeD.taskList.removeFailed');
  /**
   * Remove one row, saying so when the removal fails; a refused timed-out
   * generation says what the server answered (still finishing, or a result found).
   * @param task - The row.
   */
  const remove = React.useCallback((task: SpaceTask): void => {
    void busyWhile(task.id, setRemoving, async () => {
      try {
        await removeSpaceTask(projectId, spaceId, task.id);
      } catch (error) {
        if (error instanceof ApiException && error.status === 409 && error.fromServer) toast.warning(error.message);
        else toast.error(removeFailed);
      }
      await queryClient.invalidateQueries({ queryKey });
    });
  }, [busyWhile, projectId, spaceId, queryClient, queryKey, removeFailed]);

  /**
   * Place one finished model.
   * @param task - The row.
   */
  const place = React.useCallback((task: SpaceTask): void => {
    void busyWhile(task.id, setPlacing, () => onPlace(task));
  }, [busyWhile, onPlace]);

  /**
   * Start a failed import again from the file this page still holds.
   * @param task - The row.
   */
  const retry = React.useCallback((task: SpaceTask): void => {
    void uploads.retry(task.id).then(() => queryClient.invalidateQueries({ queryKey }));
  }, [uploads, queryClient, queryKey]);

  const stillRunning = t('spaces.threeD.taskList.stillRunning');
  const foundResult = t('spaces.threeD.taskList.hasResult');
  const checkFailed = t('spaces.threeD.taskList.checkFailed');
  /**
   * Open the generation dialog from a generation row; a timed-out one is checked
   * against the queue first, and opens only once its run has ended without a result.
   * @param task - The row.
   */
  const retryGeneration = React.useCallback((task: SpaceTask): void => {
    if (task.status !== 'expired') {
      onRetryGeneration?.(task);
      return;
    }
    void busyWhile(task.id, setChecking, async () => {
      let outcome: 'running' | 'has_result' | 'ended';
      try {
        ({ outcome } = await checkSpaceTask(projectId, spaceId, task.id));
      } catch {
        toast.error(checkFailed);
        return;
      }
      if (outcome === 'running') toast.info(stillRunning);
      else if (outcome === 'has_result') {
        toast.success(foundResult);
        await queryClient.invalidateQueries({ queryKey });
      } else onRetryGeneration?.(task);
    });
  }, [busyWhile, onRetryGeneration, projectId, spaceId, queryClient, queryKey, stillRunning, foundResult, checkFailed]);

  const filterCount = [filters.running, filters.kind !== 'all', filters.starter !== 'all', filters.origin !== 'all'].filter(Boolean).length;
  const filterMenu = <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild>
      <Button type='button' variant='ghost' size='compact' data-testid='scene-task-filter' icon={<ListFilter className='size-4' />}>
        {t('spaces.threeD.taskList.filter')}
        {filterCount > 0 ? <span data-testid='scene-task-filter-count' className='rounded-content-xs bg-accent px-1 text-xs tabular-nums'>{filterCount}</span> : null}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align='end'>
      <DropdownMenuCheckboxItem data-testid='scene-task-filter-running' checked={filters.running}
        onCheckedChange={(running) => setFilters((previous) => ({ ...previous, running: running === true }))}>{t('spaces.threeD.taskList.filterRunning')}</DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('spaces.threeD.taskList.filterKind')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={filters.kind} onValueChange={(kind) => setFilters((previous) => ({ ...previous, kind: kind as TaskFilters['kind'] }))}>
        <DropdownMenuRadioItem value='all' data-testid='scene-task-filter-kind-all'>{t('spaces.threeD.taskList.filterAll')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value='import' data-testid='scene-task-filter-kind-import'>{t('spaces.threeD.taskList.kind')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value='generation' data-testid='scene-task-filter-kind-generation'>{t('spaces.threeD.taskList.kindGeneration')}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('spaces.threeD.taskList.filterStarter')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={filters.starter} onValueChange={(starter) => setFilters((previous) => ({ ...previous, starter: starter as TaskFilters['starter'] }))}>
        <DropdownMenuRadioItem value='all' data-testid='scene-task-filter-starter-all'>{t('spaces.threeD.taskList.filterEveryone')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value='me' data-testid='scene-task-filter-starter-me'>{t('spaces.threeD.taskList.filterMe')}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t('spaces.threeD.taskList.filterOrigin')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={filters.origin} onValueChange={(origin) => setFilters((previous) => ({ ...previous, origin: origin as TaskFilters['origin'] }))}>
        <DropdownMenuRadioItem value='all' data-testid='scene-task-filter-origin-all'>{t('spaces.threeD.taskList.filterAll')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value='space' data-testid='scene-task-filter-origin-space'>{t('spaces.threeD.taskList.originSpace')}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value='agent' data-testid='scene-task-filter-origin-agent'>{t('spaces.threeD.taskList.originAgent')}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
  const filterBar = filterHost ? createPortal(filterMenu, filterHost) : <div className='flex justify-end px-2 pt-2'>{filterMenu}</div>;

  if (query.isPending) {
    return <div className='flex flex-col gap-2 p-2' data-testid='scene-tasks-panel'>{[0, 1, 2].map((index) => <Skeleton key={index} className='h-20 w-full' />)}</div>;
  }
  if (query.isError || !data) {
    return <div className='flex flex-col items-start gap-2 p-4 text-xs' data-testid='scene-tasks-panel'>
      <p>{t('spaces.threeD.taskList.loadFailed')}</p>
      <Button variant='outline' size='sm' onClick={() => { void query.refetch(); }}>{t('spaces.threeD.retry')}</Button>
    </div>;
  }
  if (data.tasks.length === 0) return <p className='p-4 text-xs text-muted-foreground' data-testid='scene-tasks-panel'>{t('spaces.threeD.taskList.empty')}</p>;

  const readAt = query.dataUpdatedAt;
  const serverNow = Date.parse(data.serverNow);
  const shown = data.tasks.filter((task) => passes(task, filters, userId));
  return <>
    {filterBar}
    <div ref={list} className='flex flex-col gap-2 p-2' data-testid='scene-tasks-panel'>
      {shown.length === 0 ? <p className='p-2 text-xs text-muted-foreground'>{t('spaces.threeD.taskList.filterEmpty')}</p> : null}
      {shown.map((task) => {
        const generation = isGenerationTask(task);
        const own = uploads.get(task.id);
        const starter = task.startedByUserId === userId ? t('spaces.threeD.taskList.you') : names?.resolve(task.startedByUserId) ?? t('spaces.threeD.taskList.member');
        const percent = generation ? undefined : own?.phase === 'uploading' ? own.percent : remoteUploads[task.id];
        const minutes = Math.floor((serverNow - Date.parse(task.startedAt) + Date.now() - readAt) / MINUTE_MS);
        const hasResult = task.assetId !== null && (task.status === 'done' || task.status === 'expired');
        const state = generation
          ? task.status === 'running' ? minutes >= 1 ? t('spaces.threeD.taskList.generatingFor', { minutes }) : t('spaces.threeD.taskList.generating')
            : t(`spaces.threeD.taskList.${hasResult ? 'done' : task.status}`)
          : task.status === 'running'
            ? own?.phase === 'registering' ? t('spaces.threeD.taskList.registering')
              : percent !== undefined ? t('spaces.threeD.taskList.uploading', { percent })
                : minutes >= 1 ? t('spaces.threeD.taskList.runningFor', { minutes }) : t('spaces.threeD.taskList.running')
            : t(`spaces.threeD.taskList.${task.status}`);
        const failure = task.status !== 'failed' ? null
          : task.errorMessage ? failureSentence(task.errorMessage, t)
            : generation ? failureSentence('internal', t) : t('spaces.threeD.taskList.failedReason');
        const placeable = canEdit && hasResult;
        const locatable = hasResult && task.assetId !== null && onLocate !== undefined && (placedAssetIds?.has(task.assetId) ?? false);
        const removable = (generation ? canGenerate : canEdit) && (task.status === 'failed' || (task.status === 'expired' && task.assetId === null));
        const retryable = generation
          ? canGenerate && onRetryGeneration !== undefined && task.startedByUserId === userId && (task.status === 'failed' || (task.status === 'expired' && task.assetId === null))
          : canEdit && task.status === 'failed' && (own?.phase === 'retained' || own?.phase === 'retrying');
        return <div key={task.id} tabIndex={-1} className='rounded-chrome border border-border p-2.5 text-sm outline-none focus-visible:border-active-border' data-testid={`scene-task-${task.id}`}>
          <div className='flex items-center gap-2'>
            <span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[hasResult ? 'done' : task.status])} />
            <Tooltip><TooltipTrigger asChild><span className='min-w-0 flex-1 truncate font-medium'>{task.label}</span></TooltipTrigger>
              <TooltipContent portal side='top' className='max-w-sm break-words'>{generation && task.prompt ? task.prompt : task.label}</TooltipContent></Tooltip>
            {generation ? <KindBadge icon={Sparkles} label={t('spaces.threeD.taskList.kindGeneration')} colorClassName='text-muted-foreground' />
              : <KindBadge icon={Upload} label={t('spaces.threeD.taskList.kind')} colorClassName='text-muted-foreground' />}
          </div>
          {generation ? <>
            {/* A text run's label already is its prompt; an image run shows its views. */}
            {task.mode === 'i23d' ? <div className='mt-1.5 flex items-center gap-1.5'>
              {task.inputs.map((input) => <HoverPreview key={input.assetId} kind='image' src={input.url}>
                <span className='inline-flex shrink-0'><img src={input.url} alt='' className='size-7 rounded-content-xs object-cover' /></span>
              </HoverPreview>)}
            </div> : null}
            <p className='mt-1 flex items-center gap-1 text-xs text-muted-foreground'>
              {task.origin === 'agent' ? <Bot className='size-3 shrink-0' aria-hidden='true' /> : null}
              {`${task.model.displayName} · ${starter} · ${task.origin === 'agent' ? t('spaces.threeD.taskList.originAgent') : t('spaces.threeD.taskList.originSpace')}`}
            </p>
            <p className='mt-0.5 text-xs text-muted-foreground'>{state}</p>
          </> : <p className='mt-1 text-xs text-muted-foreground'>{`${starter} · ${state}`}</p>}
          {task.status === 'running' && percent !== undefined && own?.phase !== 'registering'
            ? <div className='mt-1.5 h-1 overflow-hidden rounded-full bg-muted'><div className='h-full rounded-full bg-foreground' style={{ width: `${percent}%` }} /></div> : null}
          {failure === null ? null : <p className='mt-1 text-xs text-status-error'>{failure}</p>}
          {placeable || locatable || removable || retryable ? <div className='mt-2 flex flex-wrap gap-1.5'>
            {placeable ? <Button size='compact' loading={placing.has(task.id)} onClick={() => place(task)}>{t('spaces.threeD.taskList.place')}</Button> : null}
            {locatable ? <Button size='compact' variant='outline' icon={<Crosshair className='size-3.5' />} onClick={() => onLocate(task.assetId!)}>{t('spaces.threeD.taskList.locate')}</Button> : null}
            {retryable ? <Button size='compact' variant='outline' loading={generation ? checking.has(task.id) : own?.phase === 'retrying'}
              onClick={() => (generation ? retryGeneration(task) : retry(task))}>{t('spaces.threeD.taskList.retry')}</Button> : null}
            {removable ? <Button size='compact' variant='outline' loading={removing.has(task.id)} onClick={() => remove(task)}>{t('spaces.threeD.taskList.remove')}</Button> : null}
          </div> : null}
        </div>;
      })}
    </div>
  </>;
});
