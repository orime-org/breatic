// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Mounts the open node's task list beside it (#186 §7.1).
 *
 * The list is fetched, not read off the shared document: the document says
 * how many tasks are in each state and nothing more (§3.3), so the detail
 * behind a number is asked for only while somebody is looking at it.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { canvasApi, type NodeTaskEntry } from '@web/data/api/canvas';
import { useTranslation } from '@web/i18n/use-translation';
import { toast } from '@web/lib/toast';
import { NodeTaskPanel } from '@web/spaces/canvas/tasks/NodeTaskPanel';
import type { TaskStatus } from '@web/spaces/canvas/tasks/TaskStatusBadge';
import { useTickingClock } from '@web/spaces/canvas/tasks/use-ticking-clock';
import {
  clearRetryFile,
  hasRetryFile,
} from '@web/spaces/canvas/upload-retry-files';
import { useCanvasStore } from '@web/stores/canvas';

/** What this panel reads off its host: that it exists, and its four counts. */
type TaskHostNode = Pick<CanvasNodeView, 'id' | 'data'>;

/** What {@link NodeTaskPanelContainer} needs from the canvas around it. */
export interface NodeTaskPanelContainerProps {
  /**
   * The canvas's nodes, Yjs-observed. Two things are read off the host: that
   * it still exists, and its four task counts — which move on their own while
   * this list stays the snapshot one fetch returned.
   */
  nodes: ReadonlyArray<TaskHostNode>;
  /** Project the nodes belong to; the list is keyed on project and node. */
  projectId: string;
  /** Space the nodes live in, for addressing this session's retry stash. */
  spaceId: string;
  /** Write one task's result onto its node (§7.4: a direct write, no lock). */
  onReplace: (nodeId: string, task: NodeTaskEntry) => void;
  /** Send one task's stashed File again as a new task. */
  onRetry: (nodeId: string, taskId: string) => void;
}

/** The open panel's own props, once there is a host to render for. */
interface OpenNodeTaskPanelProps extends NodeTaskPanelContainerProps {
  nodeId: string;
  status: TaskStatus;
}

/**
 * The task list for one node, anchored to its right.
 * @param props - The panel inputs.
 * @param props.nodeId - The node whose tasks these are.
 * @param props.nodes - The canvas's nodes, for the host's counts and existence.
 * @param props.status - Which state the reader asked for.
 * @param props.projectId - Project the node belongs to.
 * @param props.spaceId - Space the node lives in.
 * @param props.onReplace - Write one task's result onto the node.
 * @param props.onRetry - Send one task's stashed File again.
 * @returns The anchored panel.
 */
function OpenNodeTaskPanel({
  nodeId,
  status,
  nodes,
  projectId,
  spaceId,
  onReplace,
  onRetry,
}: OpenNodeTaskPanelProps): React.JSX.Element {
  const t = useTranslation();
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const queryClient = useQueryClient();
  // Close when the host disappears (a collaborator deletes it) — mirrors the
  // Generate / reset / history panels' node-gone guard, which
  // `resolvePanelSelectionAction` leaves this case to.
  const hostNode = nodes.find((n) => n.id === nodeId);
  const nodeGone = hostNode === undefined;
  React.useEffect(() => {
    if (nodeGone) closeActivePanel();
  }, [nodeGone, closeActivePanel]);

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
      : `${counts.running}/${counts.done}/${counts.failed}/${counts.expired}`;
  const queryKey = React.useMemo(
    () => ['node-tasks', projectId, nodeId, countsKey] as const,
    [projectId, nodeId, countsKey],
  );
  const query = useQuery<NodeTaskEntry[]>({
    queryKey,
    queryFn: () => canvasApi.listNodeTasks(nodeId, projectId, spaceId),
  });
  const entries = React.useMemo(() => query.data ?? [], [query.data]);
  const anyRunning = React.useMemo(
    () => entries.some((task) => task.status === 'running'),
    [entries],
  );
  const now = useTickingClock(anyRunning);

  const holdsFile = React.useCallback(
    (taskId: string): boolean => hasRetryFile(projectId, spaceId, taskId),
    [projectId, spaceId],
  );
  const reload = React.useCallback((): void => {
    void query.refetch();
  }, [query]);
  const replace = React.useCallback(
    (taskId: string): void => {
      const task = entries.find((row) => row.id === taskId);
      if (task) onReplace(nodeId, task);
    },
    [entries, onReplace, nodeId],
  );
  const retry = React.useCallback(
    (taskId: string): void => onRetry(nodeId, taskId),
    [onRetry, nodeId],
  );
  // Finish and Clear are the same request (§7.4). The row leaves this list as
  // soon as the server takes it — the list is this reader's own fetch, not the
  // shared document. The node's counts wait for the event that follows.
  const dismiss = React.useCallback(
    (taskId: string): void => {
      void canvasApi
        .dismissNodeTask(taskId, { projectId, spaceId, nodeId })
        .then(() => {
          queryClient.setQueryData<NodeTaskEntry[]>(queryKey, (rows) =>
            (rows ?? []).filter((row) => row.id !== taskId),
          );
          clearRetryFile(projectId, spaceId, taskId);
        })
        .catch(() => {
          toast.error(t('canvas.task.dismissFailed'));
        });
    },
    [projectId, spaceId, nodeId, queryClient, queryKey, t],
  );

  return (
    // Offset past the counts column, which sits at the node's right edge with
    // an 8px margin and is 44px wide (`TaskCountColumn`, `min-w-11`). Without
    // it the list paints over the very buttons that switch and close it, since
    // the toolbar portals out at a z-index above the node's own layer.
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Right} offset={60}>
      <NodeTaskPanel
        status={status}
        entries={entries}
        now={now}
        isLoading={query.isPending}
        isError={query.isLoadingError}
        hasRetryFile={holdsFile}
        onReload={reload}
        onClose={closeActivePanel}
        onReplace={replace}
        onRetry={retry}
        onDismiss={dismiss}
      />
    </NodeToolbar>
  );
}

/**
 * Render the task list whenever it is the open node-anchored panel.
 * @param props - The panel inputs.
 * @param props.projectId - Project the nodes belong to.
 * @param props.spaceId - Space the nodes live in.
 * @param props.onReplace - Write one task's result onto its node.
 * @param props.onRetry - Send one task's stashed File again.
 * @returns The open task list, or null when another panel or none is open.
 */
export function NodeTaskPanelContainer(
  props: NodeTaskPanelContainerProps,
): React.JSX.Element | null {
  const host = useCanvasStore((s) => s.panelHostId);
  const kind = useCanvasStore((s) => s.panelKind);
  const status = useCanvasStore((s) => s.taskPanelStatus);
  if (kind !== 'tasks' || host == null || status == null) return null;
  // key={host} remounts the panel when it switches nodes, so a second node
  // never renders the first one's rows while its own fetch is in flight. The
  // query cache is keyed by project and node, so a remount reuses what it
  // already has.
  return (
    <OpenNodeTaskPanel
      key={host}
      nodeId={host}
      status={status}
      {...props}
    />
  );
}
