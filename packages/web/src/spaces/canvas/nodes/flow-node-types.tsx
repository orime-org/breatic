// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import type { ComponentType } from 'react';
import * as React from 'react';

import { useCanvasActions } from '@web/spaces/canvas/canvas-actions';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';
import { NODE_KIND_LIST, NODE_TYPES } from '@web/spaces/canvas/nodes/registry';
import { overlayCounterScale } from '@web/spaces/canvas/overlay-scale';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

/** Prop surface every node body accepts from the ReactFlow wrapper. */
interface InnerNodeProps {
  data: unknown;
  selected?: boolean;
  locked?: boolean;
  /** Commit a rename, pre-bound to this node's id (content nodes only). */
  onRename?: (name: string) => void;
}

/**
 * Wrap a registry node component for ReactFlow: adapt `NodeProps` into the
 * component's `{ data, selected, locked, onRename }` props and render the
 * source / target connection handles.
 *
 * This wrapper is the only layer that knows ReactFlow's node id, so it binds
 * the body's `onRename` to `renameNode(thisNodeId, name)` from the canvas
 * actions context — the node body knows the new name but not its own id.
 *
 * The handles live here, not in the shared `NodeShell`, because `<Handle>`
 * reads ReactFlow store context and would throw when `NodeShell` is
 * rendered in isolation (its own unit tests, future non-canvas reuse).
 * This wrapper only ever mounts inside `<ReactFlow>`, so the context is
 * guaranteed.
 * @param Inner - The registry node component for one modality.
 * @returns A ReactFlow-compatible node component.
 */
function makeFlowNode(
  Inner: ComponentType<InnerNodeProps>,
): ComponentType<NodeProps> {
  /**
   * ReactFlow node renderer: connection handles + the modality body.
   * @param props - ReactFlow node props; `data` carries the node's NodeView.
   * @returns The wrapped node element.
   */
  function FlowNode(props: NodeProps): React.JSX.Element {
    const data = props.data as unknown as NodeView;
    const { renameNode } = useCanvasActions();
    // The canvas zoom (transform[2]) lets the name header counter-scale so it
    // keeps a constant screen size — down to a floor zoom, below which it
    // shrinks with the canvas (see `overlayCounterScale`). The scissors button
    // uses the same shared factor.
    const zoom = useStore((s) => s.transform[2]);
    const headerScale = overlayCounterScale(zoom);
    const onRename = React.useCallback(
      (name: string): void => renameNode(props.id, name),
      [renameNode, props.id],
    );
    // A group node is sized by ReactFlow to its derived bounds; this wrapper
    // must fill that height so the GroupNode's own `size-full` resolves to the
    // full rect (a percentage height needs a definite-height parent chain).
    // Content nodes size to their body, so they keep the auto-height wrapper.
    const isGroup = data.kind === 'group';
    return (
      <NodeIdContext.Provider value={props.id}>
        <NodeScaleContext.Provider value={headerScale}>
          <div className={isGroup ? 'relative size-full' : 'relative'}>
            <Handle
              type='target'
              position={Position.Left}
              className='!h-2.5 !w-2.5 !border-muted-foreground !bg-background'
            />
            <Inner
              data={data}
              selected={props.selected}
              locked={data.locked}
              onRename={onRename}
            />
            <Handle
              type='source'
              position={Position.Right}
              className='!h-2.5 !w-2.5 !border-muted-foreground !bg-background'
            />
          </div>
        </NodeScaleContext.Provider>
      </NodeIdContext.Provider>
    );
  }
  return FlowNode;
}

/**
 * ReactFlow `nodeTypes` map — one handle-wrapped component per node kind,
 * keyed by the same `NodeKind` strings ReactFlow matches against `node.type`.
 */
export const FLOW_NODE_TYPES: Record<string, ComponentType<NodeProps>> =
  Object.fromEntries(
    NODE_KIND_LIST.map((kind) => [kind, makeFlowNode(NODE_TYPES[kind])]),
  );
