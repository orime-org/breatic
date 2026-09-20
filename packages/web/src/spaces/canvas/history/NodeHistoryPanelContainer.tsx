// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useCanvasStore } from '@web/stores/canvas';

import { NodeHistoryPanel } from '@web/spaces/canvas/history/NodeHistoryPanel';
import { currentEntryId } from '@web/spaces/canvas/history/history-format';
import {
  HISTORY_MODALITIES,
  type HistoryModality,
} from '@web/spaces/canvas/history/NodeHistoryRow';
import { useNodeBodyText } from '@web/spaces/canvas/history/use-node-body-text';
import { useNodeHistory } from '@web/spaces/canvas/history/use-node-history';

/**
 * How long the first page may load before the skeleton shows (#1812, C hybrid).
 * A fast load resolves before this and never flashes the skeleton; a slow load
 * gets feedback instead of an unresponsive dead click. A frontend presentation
 * constant (UI micro-timing), not a tunable runtime knob.
 */
const SKELETON_DELAY_MS = 250;

/**
 * True only once `active` has stayed true for `delayMs` — defers the loading
 * skeleton so a fast load never flashes it. Resets the moment `active` clears.
 * @param active - Whether the deferred flag is arming (e.g. still loading).
 * @param delayMs - How long `active` must persist before this returns true.
 * @returns Whether the delay has elapsed while `active` stayed true.
 */
function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  React.useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const id = setTimeout(() => setElapsed(true), delayMs);
    return () => {
      clearTimeout(id);
    };
  }, [active, delayMs]);
  return elapsed;
}

/** A node view narrowed to what the container needs. */
type HistoryHostNode = Pick<CanvasNodeView, 'id' | 'type' | 'data'>;

interface NodeHistoryPanelContainerProps {
  /** Live node views, for the host modality + content + node-gone guard. */
  nodes: ReadonlyArray<HistoryHostNode>;
  /** Project the nodes belong to (history is keyed on project + node). */
  projectId: string;
  /** Canvas space the nodes live in — a text host's words are read from it. */
  spaceId: string;
  /**
   * Gate + write the chosen entry back onto the node (owned by CanvasSpace).
   * The modality is passed so the write can be media-aware (video also writes
   * the cover) without CanvasSpace re-reading the reactive node list.
   */
  onRestore: (
    nodeId: string,
    entry: NodeHistoryEntry,
    modality: HistoryModality,
  ) => void;
}

/**
 * The node-history panel's canvas integration point (#1619). Rendered once
 * inside the ReactFlow subtree; shows nothing until a node's history panel is
 * opened (store `panelHostId` with `panelKind === 'history'` — it shares the
 * host + lifecycle with the Generate / reset panels, mutually exclusive).
 *
 * The React Query hook lives in `OpenNodeHistoryPanel`, which mounts ONLY
 * when a history panel is open — so the default canvas mount never runs
 * `useInfiniteQuery` on THIS path. It does need a `QueryClientProvider` all
 * the same: since #1966 `CanvasSpace` itself prefetches the model catalog on
 * mount, so the subtree is never provider-free. What this split still buys is
 * that a closed history panel issues no request of its own.
 * @param root0 - Component props.
 * @param root0.nodes - Live node views.
 * @param root0.projectId - Project the nodes belong to.
 * @param root0.spaceId - Canvas space the nodes live in.
 * @param root0.onRestore - Gate + write the chosen entry back onto the node.
 * @returns The open history panel, or null when none is open.
 */
export function NodeHistoryPanelContainer({
  nodes,
  projectId,
  spaceId,
  onRestore,
}: NodeHistoryPanelContainerProps): React.JSX.Element | null {
  const host = useCanvasStore((s) => s.panelHostId);
  const kind = useCanvasStore((s) => s.panelKind);
  if (kind !== 'history' || host == null) return null;
  // key={host} remounts the whole open panel (its query view AND its
  // `useDelayedFlag` grace state) when the panel switches hosts — so a fast
  // second node gets a fresh 250ms grace instead of inheriting a still-loading
  // first node's elapsed skeleton (#1812 Gate-2). The query cache is keyed by
  // project+node, so the remount reuses cached pages, no extra request.
  return (
    <OpenNodeHistoryPanel
      key={host}
      nodeId={host}
      nodes={nodes}
      projectId={projectId}
      spaceId={spaceId}
      onRestore={onRestore}
    />
  );
}

interface OpenNodeHistoryPanelProps {
  nodeId: string;
  nodes: ReadonlyArray<HistoryHostNode>;
  projectId: string;
  spaceId: string;
  onRestore: (
    nodeId: string,
    entry: NodeHistoryEntry,
    modality: HistoryModality,
  ) => void;
}

/**
 * The mounted-while-open history panel (#1619): loads the history via
 * {@link useNodeHistory}, marks the row matching the node's live content as
 * "current", and floats {@link NodeHistoryPanel} below the node.
 * @param root0 - Component props.
 * @param root0.nodeId - The open host node id.
 * @param root0.nodes - Live node views (host modality + content + gone guard).
 * @param root0.projectId - Project the node belongs to.
 * @param root0.spaceId - Canvas space the node lives in.
 * @param root0.onRestore - Gate + write the chosen entry back onto the node.
 * @returns The floating history panel, or null when the host is gone / invalid.
 */
function OpenNodeHistoryPanel({
  nodeId,
  nodes,
  projectId,
  spaceId,
  onRestore,
}: OpenNodeHistoryPanelProps): React.JSX.Element | null {
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  const hostNode = nodes.find((n) => n.id === nodeId);
  // Close when the host disappears (a collaborator deletes it) — mirrors the
  // Generate / reset panels' node-gone guard.
  const nodeGone = hostNode === undefined;
  React.useEffect(() => {
    if (nodeGone) closeActivePanel();
  }, [nodeGone, closeActivePanel]);

  const modality: HistoryModality | null =
    hostNode !== undefined && HISTORY_MODALITIES.has(hostNode.type)
      ? (hostNode.type as HistoryModality)
      : null;
  // A text node's words are not on the node view (#1774), so they are read
  // from the body itself; every other modality's content IS a view field.
  const bodyText = useNodeBodyText(
    projectId,
    spaceId,
    nodeId,
    modality === 'text',
  );
  // Live content (drives the "current" marker + the refetch) — reactive
  // either way: the `nodes` prop is Yjs-observed and so is the body.
  const currentContent =
    modality === 'text'
      ? bodyText
      : hostNode !== undefined && 'content' in hostNode.data
        ? (hostNode.data.content ?? null)
        : null;

  // How many runs on this node have reached an end. A run that finishes
  // while the panel is open wrote a row the list knows nothing about, and
  // this count moving is what says so — the same signal for every modality,
  // where the node's content would not be: a text node's words are written
  // by the reader too, and a keystroke is not a new row.
  const counts =
    hostNode !== undefined && 'taskCounts' in hostNode.data
      ? hostNode.data.taskCounts
      : undefined;
  const settledRuns =
    counts === undefined
      ? null
      : counts.done + counts.failed + counts.expired;

  // The row a reader last put back on this node. "Current" names which row
  // the node is on, and content cannot tell two rows holding the same thing
  // apart — the reader picked one of them.
  const restoredFrom =
    hostNode !== undefined && 'restoredFromEntryId' in hostNode.data
      ? hostNode.data.restoredFromEntryId
      : undefined;

  const history = useNodeHistory(nodeId, projectId, settledRuns);
  const currentId = React.useMemo(
    () => currentEntryId(history.entries, currentContent, restoredFrom),
    [history.entries, currentContent, restoredFrom],
  );
  const handleRestore = React.useCallback(
    (entry: NodeHistoryEntry): void => {
      if (modality != null) onRestore(nodeId, entry, modality);
    },
    [nodeId, modality, onRestore],
  );

  // C hybrid (#1812): defer the skeleton behind a grace delay. `isPending`
  // (status==='pending' = NO data) covers loading AND the offline pause that
  // `isLoading` misses (Gate-2: a paused query would else fall through to a
  // false "No history yet"). `showSkeleton` is true only once the load outlasts
  // the grace window, so a fast INITIAL load never flashes the skeleton. An
  // offline pause keeps `isPending` true, so the skeleton persists until
  // reconnect — accepted (Gate-2 round-1 #8): the app's global connection-status
  // banner is the offline affordance, not this panel.
  const { isPending, isLoadingError, retry } = history;

  // A USER-triggered retry gets IMMEDIATE feedback (skips the grace) — a user
  // action must be acknowledged instantly (RAIL/Doherty), unlike the passive
  // initial load. React Query resets a no-data errored query to
  // status==='pending' on refetch (query-core reducer), so the retry re-enters
  // this loading path; `retryRequested` makes it show the skeleton at once
  // (no 250ms panel-vanish), then resets when the retry settles (#1812 Gate-2,
  // B, user 2026-07-23).
  const [retryRequested, setRetryRequested] = React.useState(false);
  const handleRetry = React.useCallback((): void => {
    setRetryRequested(true);
    retry();
  }, [retry]);
  React.useEffect(() => {
    if (!isPending) setRetryRequested(false);
  }, [isPending]);

  const showSkeleton =
    useDelayedFlag(isPending, SKELETON_DELAY_MS) ||
    (isPending && retryRequested);

  if (hostNode === undefined || modality === null) return null;
  // Grace window: still loading, delay not yet elapsed AND not a user retry →
  // render nothing (no flash). Once the delay passes (or the user retries) the
  // panel shows a skeleton; a first-page error shows the panel with an in-panel
  // error + retry (no toast, no close).
  if (isPending && !showSkeleton) return null;

  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {/* Host-switch freshness (query view + scroll + grace state) is owned by
          the outer key={host} on OpenNodeHistoryPanel — this subtree remounts
          with it, so no inner key is needed. */}
      <NodeHistoryPanel
        entries={history.entries}
        total={history.total}
        modality={modality}
        currentEntryId={currentId}
        isLoading={isPending}
        isError={isLoadingError}
        onRetry={handleRetry}
        hasNextPage={history.hasNextPage}
        isFetchingNextPage={history.isFetchingNextPage}
        onLoadMore={history.fetchNextPage}
        onRestore={handleRestore}
        onClose={closeActivePanel}
      />
    </NodeToolbar>
  );
}
