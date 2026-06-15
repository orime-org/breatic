// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import * as React from 'react';

import {
  addEdge,
  removeNode,
  setNodePosition,
  useCanvasSpace,
  type CanvasEdge,
  type CanvasNodeView,
} from '@web/data/yjs/canvas-space';
import { useTranslation } from '@web/i18n/use-translation';
import type { SpaceBodyProps } from '@web/spaces';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';

const DELETE_KEYS = ['Backspace', 'Delete'];

/**
 * Project a Yjs canvas node view into a ReactFlow node. ReactFlow's
 * `node.type` is the view `kind` (the `FLOW_NODE_TYPES` lookup key) and
 * `node.data` carries the full narrowed view for the body to render.
 * @param node - The canvas node view from the Yjs binding.
 * @returns The ReactFlow node.
 */
function toFlowNode(node: CanvasNodeView): Node {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data as unknown as Record<string, unknown>,
  };
}

/**
 * Project a Yjs canvas edge into a ReactFlow edge.
 * @param edge - The canvas edge from the Yjs binding.
 * @returns The ReactFlow edge.
 */
function toFlowEdge(edge: CanvasEdge): Edge {
  return { id: edge.id, source: edge.source, target: edge.target };
}

/**
 * Canvas body — mounts ReactFlow over the Yjs-backed canvas space.
 *
 * Yjs is the single source of truth: `useCanvasSpace` observes the doc and
 * the observed nodes are mirrored into ReactFlow's local render buffer
 * (`flowNodes`) so drag stays smooth. The three frontend-owned mutations
 * are bridged back to Yjs — position on drag stop, deletion, and edge
 * connect. The backend never creates / deletes / moves nodes; it only
 * writes state fields into a node's `data` (see the canvas-space binding).
 * @param root0 - Space body props from the project space outlet.
 * @param root0.projectId - Owning project id.
 * @param root0.spaceId - Canvas space id.
 * @returns The ReactFlow canvas surface.
 */
function CanvasSpaceInner({
  projectId,
  spaceId,
}: SpaceBodyProps): React.JSX.Element {
  const t = useTranslation();
  const { nodes, edges } = useCanvasSpace(projectId, spaceId);
  const [flowNodes, setFlowNodes] = React.useState<Node[]>([]);

  // Mirror the Yjs-observed nodes into ReactFlow's render buffer. ReactFlow
  // needs a local node array for smooth drag; Yjs stays the source of truth
  // and positions are persisted back on drag stop (onNodeDragStop).
  React.useEffect(() => {
    setFlowNodes(nodes.map(toFlowNode));
  }, [nodes]);

  const flowEdges = React.useMemo(() => edges.map(toFlowEdge), [edges]);

  const onNodesChange = React.useCallback((changes: NodeChange[]): void => {
    setFlowNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onNodeDragStop = React.useCallback(
    (_event: React.MouseEvent, node: Node): void => {
      setNodePosition(projectId, spaceId, node.id, node.position);
    },
    [projectId, spaceId],
  );

  const onNodesDelete = React.useCallback(
    (deleted: Node[]): void => {
      deleted.forEach((node) => removeNode(projectId, spaceId, node.id));
    },
    [projectId, spaceId],
  );

  const onConnect = React.useCallback(
    (connection: Connection): void => {
      if (!connection.source || !connection.target) return;
      addEdge(projectId, spaceId, {
        id: `${connection.source}->${connection.target}`,
        source: connection.source,
        target: connection.target,
        kind: 'primary',
      });
    },
    [projectId, spaceId],
  );

  return (
    <div
      data-testid='canvas-space'
      data-project-id={projectId}
      data-space-id={spaceId}
      className='relative h-full w-full bg-canvas'
    >
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={FLOW_NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        onConnect={onConnect}
        deleteKeyCode={DELETE_KEYS}
        proOptions={{ hideAttribution: true }}
        fitView
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color='var(--color-canvas-grid)'
        />
      </ReactFlow>
      {flowNodes.length === 0 ? (
        <div
          data-testid='canvas-empty'
          className='pointer-events-none absolute inset-0 flex items-center justify-center text-center text-sm leading-relaxed text-muted-foreground'
        >
          <div className='max-w-[360px] rounded-lg border border-dashed border-border bg-card px-6 py-4'>
            <strong className='block text-foreground'>
              {t('canvas.emptyState.title')}
            </strong>
            <span className='text-xs text-muted-foreground'>
              {t('canvas.emptyState.hint')}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Canvas space body. Wraps {@link CanvasSpaceInner} in a
 * `ReactFlowProvider` so the canvas and any future chrome (viewport
 * toolbar zoom controls) share one ReactFlow store.
 * @param props - Space body props supplied by the project space outlet.
 * @returns The provider-wrapped canvas surface.
 */
export function CanvasSpace(props: SpaceBodyProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasSpaceInner {...props} />
    </ReactFlowProvider>
  );
}
