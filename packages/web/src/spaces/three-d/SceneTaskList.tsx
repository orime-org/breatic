// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { listSpaceTasks, removeSpaceTask, spaceTasksQueryKey, type SpaceTask } from '@web/data/api/scene';
import { Button } from '@web/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@web/components/ui/tooltip';
import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { cn } from '@web/lib/utils';
import { KindBadge } from '@web/spaces/canvas/_shared/KindBadge';
import { failureSentence } from '@web/spaces/canvas/failure-sentence';
import type { SceneUploads } from '@web/spaces/three-d/scene-uploads';

interface SceneTaskListProps {
  projectId: string;
  spaceId: string;
  userId: string;
  canEdit: boolean;
  /** The page's own uploads: live percent, registration and which rows it may retry. */
  uploads: SceneUploads;
  /** Other pages' whole-percent progress, by task row. */
  remoteUploads: Readonly<Record<string, number>>;
  /** Place a finished model into the scene; resolves once placed or refused. */
  onPlace: (task: SpaceTask) => Promise<void>;
  /** The row a just-started upload opened, which takes focus once listed. */
  focusTaskId?: string | null;
  /** Called once the handed row has taken focus. */
  onFocused?: () => void;
}

const MINUTE_MS = 60_000;
const DOT_CLASS: Record<SpaceTask['status'], string> = {
  running: 'bg-status-info',
  done: 'bg-status-success',
  failed: 'bg-status-error',
  expired: 'bg-status-warning',
};

/**
 * The 3D Space's task list (inner#1690): every member's model uploads, and
 * the finished ones placed into the scene from here.
 *
 * The rows are the server's; this page adds what only it knows about the
 * uploads it sends. The list is read again when the server signals a change
 * (the page invalidates its query) and when the earliest running row reaches
 * its deadline, timed from the server's clock so a browser clock that runs
 * ahead cannot reread in a loop.
 * @param props - Space identity, edit right, the page's uploads and the place handler.
 * @returns The list.
 */
export const SceneTaskList = React.memo(function SceneTaskList({ projectId, spaceId, userId, canEdit, uploads, remoteUploads, onPlace, focusTaskId, onFocused }: SceneTaskListProps): React.JSX.Element {
  const t = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = React.useMemo(() => spaceTasksQueryKey(projectId, spaceId), [projectId, spaceId]);
  const query = useQuery({ queryKey, queryFn: ({ signal }) => listSpaceTasks(projectId, spaceId, signal) });
  React.useSyncExternalStore(uploads.subscribe, uploads.getVersion);
  const names = useCollaboratorNames();
  const [placing, setPlacing] = React.useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = React.useState<ReadonlySet<string>>(new Set());
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
    const target = list.current?.querySelector<HTMLElement>(`[data-testid="scene-task-${focusTaskId}"]`);
    if (!target) return;
    target.focus();
    onFocused?.();
  }, [focusTaskId, data, onFocused]);

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

  /**
   * Remove one row, saying so when the removal fails.
   * @param task - The row.
   */
  const remove = React.useCallback((task: SpaceTask): void => {
    void busyWhile(task.id, setRemoving, async () => {
      try {
        await removeSpaceTask(projectId, spaceId, task.id);
      } catch {
        toast.error(t('spaces.threeD.taskList.removeFailed'));
      }
      await queryClient.invalidateQueries({ queryKey });
    });
  }, [busyWhile, projectId, spaceId, queryClient, queryKey, t]);

  /**
   * Place one finished model.
   * @param task - The row.
   */
  const place = React.useCallback((task: SpaceTask): void => {
    void busyWhile(task.id, setPlacing, () => onPlace(task));
  }, [busyWhile, onPlace]);

  /**
   * Start a failed row again from the file this page still holds.
   * @param task - The row.
   */
  const retry = React.useCallback((task: SpaceTask): void => {
    void uploads.retry(task.id).then(() => queryClient.invalidateQueries({ queryKey }));
  }, [uploads, queryClient, queryKey]);

  if (query.isPending) return <p className='p-4 text-xs text-muted-foreground' data-testid='scene-tasks-panel'>{t('spaces.threeD.loading')}</p>;
  if (query.isError || !data) {
    return <div className='flex flex-col items-start gap-2 p-4 text-xs' data-testid='scene-tasks-panel'>
      <p>{t('spaces.threeD.taskList.loadFailed')}</p>
      <Button variant='outline' size='sm' onClick={() => { void query.refetch(); }}>{t('spaces.threeD.retry')}</Button>
    </div>;
  }
  if (data.tasks.length === 0) return <p className='p-4 text-xs text-muted-foreground' data-testid='scene-tasks-panel'>{t('spaces.threeD.taskList.empty')}</p>;

  const readAt = query.dataUpdatedAt;
  const serverNow = Date.parse(data.serverNow);
  return <div ref={list} className='flex flex-col gap-2 p-2' data-testid='scene-tasks-panel'>
    {data.tasks.map((task) => {
      const own = uploads.get(task.id);
      const starter = task.startedByUserId === userId ? t('spaces.threeD.taskList.you') : names?.resolve(task.startedByUserId) ?? t('spaces.threeD.taskList.member');
      const percent = own?.phase === 'uploading' ? own.percent : remoteUploads[task.id];
      const minutes = Math.floor((serverNow - Date.parse(task.startedAt) + Date.now() - readAt) / MINUTE_MS);
      const state = task.status === 'running'
        ? own?.phase === 'registering' ? t('spaces.threeD.taskList.registering')
          : percent !== undefined ? t('spaces.threeD.taskList.uploading', { percent })
            : minutes >= 1 ? t('spaces.threeD.taskList.runningFor', { minutes }) : t('spaces.threeD.taskList.running')
        : t(`spaces.threeD.taskList.${task.status}`);
      const placeable = canEdit && task.assetId !== null && (task.status === 'done' || task.status === 'expired');
      const removable = canEdit && (task.status === 'failed' || (task.status === 'expired' && task.assetId === null));
      const retryable = canEdit && task.status === 'failed' && (own?.phase === 'retained' || own?.phase === 'retrying');
      return <div key={task.id} tabIndex={-1} className='rounded-chrome border border-border p-2.5 text-sm outline-none focus-visible:border-active-border' data-testid={`scene-task-${task.id}`}>
        <div className='flex items-center gap-2'>
          <span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[task.status])} />
          <Tooltip><TooltipTrigger asChild><span className='min-w-0 flex-1 truncate font-medium'>{task.label}</span></TooltipTrigger>
            <TooltipContent portal side='top'>{task.label}</TooltipContent></Tooltip>
          <KindBadge icon={Upload} label={t('spaces.threeD.taskList.kind')} colorClassName='text-muted-foreground' />
        </div>
        <p className='mt-1 text-xs text-muted-foreground'>{`${starter} · ${state}`}</p>
        {task.status === 'running' && percent !== undefined && own?.phase !== 'registering'
          ? <div className='mt-1.5 h-1 overflow-hidden rounded-full bg-muted'><div className='h-full rounded-full bg-foreground' style={{ width: `${percent}%` }} /></div> : null}
        {task.status === 'failed' ? <p className='mt-1 text-xs text-status-error'>{task.errorMessage ? failureSentence(task.errorMessage, t) : t('spaces.threeD.taskList.failedReason')}</p> : null}
        {placeable || removable || retryable ? <div className='mt-2 flex gap-1.5'>
          {placeable ? <Button size='compact' loading={placing.has(task.id)} onClick={() => place(task)}>{t('spaces.threeD.taskList.place')}</Button> : null}
          {retryable ? <Button size='compact' variant='outline' loading={own?.phase === 'retrying'} onClick={() => retry(task)}>{t('spaces.threeD.taskList.retry')}</Button> : null}
          {removable ? <Button size='compact' variant='outline' loading={removing.has(task.id)} onClick={() => remove(task)}>{t('spaces.threeD.taskList.remove')}</Button> : null}
        </div> : null}
      </div>;
    })}
  </div>;
});
