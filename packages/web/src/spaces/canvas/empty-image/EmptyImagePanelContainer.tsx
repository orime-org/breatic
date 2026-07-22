// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

import { useCanvasStore } from '@web/stores/canvas';

import {
  EmptyImagePanel,
  type EmptyImageExecuteOpts,
} from '@web/spaces/canvas/empty-image/EmptyImagePanel';

interface EmptyImagePanelContainerProps {
  /** Live nodes, for the node-gone guard (a collaborator deleting the host). */
  nodes: ReadonlyArray<{ id: string }>;
  /** Rasterise + gate + write the blank image back (owned by CanvasSpace). */
  onReset: (nodeId: string, opts: EmptyImageExecuteOpts) => void;
}

/**
 * The reset-empty-image panel's canvas integration point (#1623). Rendered once
 * inside the ReactFlow subtree; shows nothing until a node's reset panel is
 * opened (store `panelHostId` with `panelKind === 'resetEmpty'` — it shares the
 * host + lifecycle with the Generate panel, which renders its own container),
 * then floats {@link EmptyImagePanel} below that node via `NodeToolbar`.
 * @param root0 - Component props.
 * @param root0.nodes - Live nodes, for the node-gone guard.
 * @param root0.onReset - Rasterise + gate + write the blank image back.
 * @returns The floating reset panel, or null when none is open.
 */
export function EmptyImagePanelContainer({
  nodes,
  onReset,
}: EmptyImagePanelContainerProps): React.JSX.Element | null {
  const host = useCanvasStore((s) => s.panelHostId);
  const kind = useCanvasStore((s) => s.panelKind);
  const closeActivePanel = useCanvasStore((s) => s.closeActivePanel);
  // Only this container's kind; the Generate panel shares `panelHostId`.
  const nodeId = kind === 'resetEmpty' ? host : null;
  // Close when the host disappears (a collaborator deletes it) so we never
  // render a stale panel — mirrors the Generate panel's node-gone guard.
  const nodeGone = nodeId != null && !nodes.some((n) => n.id === nodeId);
  React.useEffect(() => {
    if (nodeGone) closeActivePanel();
  }, [nodeGone, closeActivePanel]);
  // Stable per host so the memoized EmptyImagePanel bails when this container
  // re-renders for unrelated store changes (the panel is remounted per host by
  // `key={nodeId}`, so binding `nodeId` here is safe).
  const handleExecute = React.useCallback(
    (opts: EmptyImageExecuteOpts): void => {
      if (nodeId != null) onReset(nodeId, opts);
    },
    [nodeId, onReset],
  );
  if (nodeId == null || nodeGone) return null;
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {/* key={nodeId} remounts the form (fresh W/H / colour) when the panel
          switches hosts, so one node's picks can never execute against another. */}
      <EmptyImagePanel
        key={nodeId}
        onExecute={handleExecute}
        onExit={closeActivePanel}
      />
    </NodeToolbar>
  );
}
