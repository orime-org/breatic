// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mounts the open node's task list beside it (#186 §7.1).
 *
 * The list is fetched, not read off the shared document: the document says
 * how many tasks are in each state and nothing more (§3.3), so the detail
 * behind a number is asked for only while somebody is looking at it.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NodeToolbar, Position, useStore } from '@xyflow/react';
import * as React from 'react';

import type { NodeRef } from '@web/data/yjs/node-view';
import type { NodeTaskCounts, NodeTaskEntry } from '@breatic/shared';

import { canvasApi } from '@web/data/api/canvas';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { toastCancelFailure } from '@web/spaces/canvas/tasks/cancel-failure';
import { NodeTaskPanel, countInList, inTaskList } from '@web/spaces/canvas/tasks/NodeTaskPanel';
import type { TaskListKind } from '@web/spaces/canvas/tasks/TaskStatusDot';
import { useTickingClock } from '@web/spaces/canvas/tasks/use-ticking-clock';
import {
  clearRetryFile,
  hasRetryFile,
} from '@web/spaces/canvas/upload-retry-files';
import { countsColumnOffset } from '@web/spaces/canvas/overlay-scale';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import {
  taskActionKey,
  trackTaskAction,
  useTaskActionsInFlight,
  type TaskActionRequest,
} from '@web/stores/task-actions-in-flight';

/** The media a refusal can name formats for. */
const LISTED_MEDIA = ['image', 'video', 'audio'] as const;

/** What this panel reads off its host: that it exists, and its counts. */
type TaskHostNode = NodeRef;

/** What {@link NodeTaskPanelContainer} needs from the canvas around it. */
export interface NodeTaskPanelContainerProps {
  /**
   * The canvas's nodes, Yjs-observed. Two things are read off the host: that
   * it still exists, and its task counts — which move on their own while
   * this list stays the snapshot one fetch returned.
   */
  nodes: ReadonlyArray<TaskHostNode>;
  /** Project the nodes belong to; the list is keyed on project and node. */
  projectId: string;
  /** Space the nodes live in, for addressing this session's retry stash. */
  spaceId: string;
  /** Whether this user may write; a read-only row carries no buttons. */
  readOnly: boolean;
  /**
   * Send one task's stashed File again as a new task. Returns the upload's
   * work, or undefined when nothing was sent (a lock, or no File held).
   */
  onRetry: (nodeId: string, taskId: string) => Promise<void> | undefined;
}

/** The open panel's own props, once there is a host to render for. */
interface OpenNodeTaskPanelProps extends NodeTaskPanelContainerProps {
  nodeId: string;
  status: TaskListKind;
}

/**
 * The task list for one node, anchored to its right.
 * @param props - The panel inputs.
 * @param props.nodeId - The node whose tasks these are.
 * @param props.nodes - The canvas's nodes, for the host's counts and existence.
 * @param props.status - Which state the user asked for.
 * @param props.projectId - Project the node belongs to.
 * @param props.spaceId - Space the node lives in.
 * @param props.readOnly - Whether this user may write.
 * @param props.onRetry - Send one task's stashed File again.
 * @returns The anchored panel, or null once its host node is gone.
 */
function OpenNodeTaskPanel({
  nodeId,
  status,
  nodes,
  projectId,
  spaceId,
  readOnly,
  onRetry,
}: OpenNodeTaskPanelProps): React.JSX.Element | null {
  const t = useTranslation();
  const zoom = useStore((s) => s.transform[2]);
  const closeActivePanel = useCanvasSession((s) => s.closeActivePanel);
  const session = useCanvasSessionStore();
  const openHistoryPanel = useCanvasSession((s) => s.openHistoryPanel);
  // Each row's first line names a model by what the catalog calls it. The
  // catalog is already cached by the time a list opens on a canvas.
  const catalog = useQuery(modelCatalogQuery()).data;
  const displayNameOf = React.useMemo(() => {
    const names = new Map<string, string>();
    if (catalog) {
      for (const bucket of [catalog.image, catalog.video, catalog.audio, catalog.tts, catalog.three_d]) {
        for (const model of bucket) names.set(model.name, model.display_name);
      }
    }
    return (modelId: string): string | null => names.get(modelId) ?? null;
  }, [catalog]);
  const queryClient = useQueryClient();
  // A deleted host draws nothing here; `CanvasSpaceInner` closes the panel.
  const hostNode = nodes.find((n) => n.id === nodeId);
  // What the node holds, for the refusal sentence that names the formats we
  // would have taken. Only the three media have a list; every other type
  // leaves the sentence its short form.
  const hostMedium = LISTED_MEDIA.find((name) => hostNode?.type === name);

  // The counts come off the document and move live; these rows are one fetch.
  // Keying on them is what keeps the two from contradicting each other on
  // screen — a row counting down beside a count that already says the task
  // ended — and it makes opening the list show the state its counts describe
  // whatever the cache holds.
  // A group and an annotation hold no tasks, so their views carry no counts.
  const counts =
    hostNode !== undefined && 'taskCounts' in hostNode.data
      ? hostNode.data.taskCounts
      : undefined;
  const countsKey =
    counts === undefined
      ? 'none'
      : `${counts.running}/${counts.waiting ?? 0}/${counts.done}/${counts.failed}/${counts.expired}`;
  const queryKey = React.useMemo(
    () => ['node-tasks', projectId, nodeId, countsKey] as const,
    [projectId, nodeId, countsKey],
  );
  const query = useQuery<NodeTaskEntry[]>({
    queryKey,
    queryFn: () => canvasApi.listNodeTasks(nodeId, projectId, spaceId),
    // The key is the counts themselves, and those come back around: a task
    // finishes, the user clears it, and the next upload puts the node back
    // where it began. Cached, that repeat would show the task that was cleared
    // — running, counting up, with no button to get rid of it — and the read
    // that harvests (§4.6) would never reach the server.
    staleTime: 0,
    gcTime: 0,
  });
  const entries = React.useMemo(() => query.data ?? [], [query.data]);
  // Only the running list reads the clock, and only while it has a row: the
  // three settled states show fixed instants.
  const counting = React.useMemo(
    () =>
      status === 'running' && entries.some((task) => inTaskList(task, 'running')),
    [status, entries],
  );
  const now = useTickingClock(counting);

  const holdsFile = React.useCallback(
    (taskId: string): boolean => hasRetryFile(projectId, spaceId, taskId),
    [projectId, spaceId],
  );
  // Read from a store, not this panel's state: a button still waits after the
  // panel is closed and opened again.
  const inFlight = useTaskActionsInFlight((s) => s.inFlight);
  const isWaiting = React.useCallback(
    (taskId: string, request: TaskActionRequest): boolean =>
      inFlight.has(taskActionKey(projectId, spaceId, taskId, request)),
    [inFlight, projectId, spaceId],
  );
  const reload = React.useCallback((): void => {
    void query.refetch();
  }, [query]);
  // A late result lives in the node's history only; the user restores it
  // from there (inner#888 §7.7).
  const view = React.useCallback(
    (taskId: string): void => {
      const task = entries.find((row) => row.id === taskId);
      if (task?.nodeHistoryId) openHistoryPanel(nodeId, task.nodeHistoryId);
    },
    [entries, openHistoryPanel, nodeId],
  );
  // Retry waits for the whole re-send: the failed row stays where it is (the
  // re-send is a new task), so a second press would send the File twice.
  const retry = React.useCallback(
    (taskId: string): void => {
      const work = onRetry(nodeId, taskId);
      if (work !== undefined) {
        trackTaskAction(taskActionKey(projectId, spaceId, taskId, 'retry'), work);
      }
    },
    [onRetry, nodeId, projectId, spaceId],
  );
  // A row leaves the state this panel shows: cleared, or cancelled and ended.
  // The count cell this panel opened from is drawn only while its own state
  // holds a task, so the last row of THAT state leaving takes the cell with it.
  // Whether any is left is read from the counts the server answered with: the
  // list's cache is keyed on the node's counts, and a counts event that lands
  // first moves it to a key not read yet. An answer that lands after the user
  // opened another panel leaves that panel alone.
  const rowLeft = React.useCallback(
    (taskId: string, counts: NodeTaskCounts): void => {
      queryClient.setQueryData<NodeTaskEntry[]>(queryKey, (rows) => rows?.filter((row) => row.id !== taskId));
      const open = session.getState();
      if (open.panelKind !== 'tasks' || open.panelHostId !== nodeId || open.taskPanelStatus !== status) return;
      if (countInList(counts, status) === 0) closeActivePanel();
    },
    [queryClient, queryKey, session, nodeId, status, closeActivePanel],
  );
  // Finish and Clear are the same request (§7.4). The row leaves this list as
  // soon as the server takes it — the list is this user's own fetch, not the
  // shared document. The node's counts wait for the event that follows.
  const dismiss = React.useCallback(
    (taskId: string): void => {
      const request = canvasApi
        .dismissNodeTask(taskId, { projectId, spaceId, nodeId })
        .then(({ counts }) => {
          clearRetryFile(projectId, spaceId, taskId);
          rowLeft(taskId, counts);
        })
        .catch(() => {
          toast.error(t('canvas.task.dismissFailed'));
        });
      trackTaskAction(taskActionKey(projectId, spaceId, taskId, 'dismiss'), request);
    },
    [projectId, spaceId, nodeId, t, rowLeft],
  );

  // Cancel a task that waits for a free slot (inner#1968). The row ends as a
  // failed one, so it leaves the queued list, the only one that offers Cancel.
  // One that started meanwhile answers 409 with the server's sentence.
  const cancel = React.useCallback(
    (taskId: string): void => {
      const request = canvasApi
        .cancelTask(taskId)
        .then(({ counts }) => {
          // A 3D Space's own row answers no node counts; this list is a node's.
          if (counts !== null) rowLeft(taskId, counts);
        })
        .catch((err: unknown) => {
          toastCancelFailure(err, t('canvas.task.cancelFailed'));
        });
      trackTaskAction(taskActionKey(projectId, spaceId, taskId, 'cancel'), request);
    },
    [projectId, spaceId, t, rowLeft],
  );

  if (hostNode === undefined) return null;
  return (
    // Offset past the counts column. xyflow adds this after the zoom multiply,
    // so it is screen pixels — and the column is not one measurement but two,
    // only one of which is a screen constant. Without following the zoom the
    // list paints over the very buttons that switch and close it, since the
    // toolbar portals out at a z-index above the node's own layer.
    // `align='start'` puts the panel's top edge on the node's, which is where
    // the counts column that opens it sits. Centred, the two are half a node
    // apart — a gap that grows with the node and puts the panel outside the
    // viewport entirely once the node is taller than it.
    <NodeToolbar
      nodeId={nodeId}
      isVisible
      position={Position.Right}
      align='start'
      offset={countsColumnOffset(zoom)}
    >
      <NodeTaskPanel
        status={status}
        entries={entries}
        readOnly={readOnly}
        {...(hostMedium !== undefined && { medium: hostMedium })}
        now={now}
        isLoading={query.isPending}
        isError={query.isLoadingError}
        hasRetryFile={holdsFile}
        isWaiting={isWaiting}
        onReload={reload}
        onClose={closeActivePanel}
        onView={view}
        displayNameOf={displayNameOf}
        onRetry={retry}
        onDismiss={dismiss}
        onCancel={cancel}
      />
    </NodeToolbar>
  );
}

/**
 * Render the task list whenever it is the open node-anchored panel.
 * @param props - The panel inputs.
 * @param props.projectId - Project the nodes belong to.
 * @param props.spaceId - Space the nodes live in.
 * @param props.readOnly - Whether this user may write.
 * @param props.onRetry - Send one task's stashed File again.
 * @returns The open task list, or null when another panel or none is open.
 */
export function NodeTaskPanelContainer(
  props: NodeTaskPanelContainerProps,
): React.JSX.Element | null {
  const host = useCanvasSession((s) => s.panelHostId);
  const kind = useCanvasSession((s) => s.panelKind);
  const status = useCanvasSession((s) => s.taskPanelStatus);
  if (kind !== 'tasks' || host == null || status == null) return null;
  // key={host} remounts the panel when it switches nodes, so a second node
  // never renders the first one's rows while its own fetch is in flight.
  return (
    <OpenNodeTaskPanel
      key={host}
      nodeId={host}
      status={status}
      {...props}
    />
  );
}
