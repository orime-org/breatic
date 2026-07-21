// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import type { NodeHistoryEntry } from '@web/data/api/canvas';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { useCanvasStore } from '@web/stores/canvas';

import { NodeHistoryPanel } from '@web/spaces/canvas/history/NodeHistoryPanel';
import { currentEntryId } from '@web/spaces/canvas/history/history-format';
import type { HistoryModality } from '@web/spaces/canvas/history/NodeHistoryRow';
import { useNodeHistory } from '@web/spaces/canvas/history/use-node-history';

/** The modalities the history panel supports (its right-click entry is gated to these). */
const HISTORY_MODALITIES: ReadonlySet<string> = new Set([
  'image',
  'video',
  'audio',
]);

/** A node view narrowed to what the container needs. */
type HistoryHostNode = Pick<CanvasNodeView, 'id' | 'type' | 'data'>;

interface NodeHistoryPanelContainerProps {
  /** Live node views, for the host modality + content + node-gone guard. */
  nodes: ReadonlyArray<HistoryHostNode>;
  /** Project the nodes belong to (history is keyed on project + node). */
  projectId: string;
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
 * The React Query hook lives in {@link OpenNodeHistoryPanel}, which mounts ONLY
 * when a history panel is open — so the default canvas mount never runs
 * `useInfiniteQuery` and needs no `QueryClientProvider`.
 * @param root0 - Component props.
 * @param root0.nodes - Live node views.
 * @param root0.projectId - Project the nodes belong to.
 * @param root0.onRestore - Gate + write the chosen entry back onto the node.
 * @returns The open history panel, or null when none is open.
 */
export function NodeHistoryPanelContainer({
  nodes,
  projectId,
  onRestore,
}: NodeHistoryPanelContainerProps): React.JSX.Element | null {
  const host = useCanvasStore((s) => s.panelHostId);
  const kind = useCanvasStore((s) => s.panelKind);
  if (kind !== 'history' || host == null) return null;
  return (
    <OpenNodeHistoryPanel
      nodeId={host}
      nodes={nodes}
      projectId={projectId}
      onRestore={onRestore}
    />
  );
}

interface OpenNodeHistoryPanelProps {
  nodeId: string;
  nodes: ReadonlyArray<HistoryHostNode>;
  projectId: string;
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
 * @param root0.onRestore - Gate + write the chosen entry back onto the node.
 * @returns The floating history panel, or null when the host is gone / invalid.
 */
function OpenNodeHistoryPanel({
  nodeId,
  nodes,
  projectId,
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

  // Live content (drives the "current" marker + the refetch) — reactive via the
  // `nodes` prop (Yjs-observed), not a one-shot read.
  const currentContent =
    hostNode !== undefined && 'content' in hostNode.data
      ? (hostNode.data.content ?? null)
      : null;
  const modality: HistoryModality | null =
    hostNode !== undefined && HISTORY_MODALITIES.has(hostNode.type)
      ? (hostNode.type as HistoryModality)
      : null;

  const history = useNodeHistory(nodeId, projectId, currentContent);
  const currentId = React.useMemo(
    () => currentEntryId(history.entries, currentContent),
    [history.entries, currentContent],
  );
  const handleRestore = React.useCallback(
    (entry: NodeHistoryEntry): void => {
      if (modality != null) onRestore(nodeId, entry, modality);
    },
    [nodeId, modality, onRestore],
  );

  if (hostNode === undefined || modality === null) return null;

  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {/* key={nodeId} remounts the panel (fresh query view + scroll state)
          when it switches hosts. */}
      <NodeHistoryPanel
        key={nodeId}
        entries={history.entries}
        total={history.total}
        modality={modality}
        currentEntryId={currentId}
        isLoading={history.isLoading}
        isError={history.isError}
        hasNextPage={history.hasNextPage}
        isFetchingNextPage={history.isFetchingNextPage}
        onLoadMore={history.fetchNextPage}
        onRetry={history.retry}
        onRestore={handleRestore}
        onClose={closeActivePanel}
      />
    </NodeToolbar>
  );
}
