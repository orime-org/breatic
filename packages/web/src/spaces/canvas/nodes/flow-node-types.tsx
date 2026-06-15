// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ComponentType } from 'react';
import type * as React from 'react';

import { NODE_KIND_LIST, NODE_TYPES } from '@web/spaces/canvas/nodes/registry';
import type { NodeView } from '@web/spaces/canvas/types/node-view';

/**
 * Wrap a registry node component for ReactFlow: adapt `NodeProps` into the
 * component's `{ data, selected, locked }` props and render the source /
 * target connection handles.
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
  Inner: ComponentType<{ data: unknown; selected?: boolean; locked?: boolean }>,
): ComponentType<NodeProps> {
  /**
   * ReactFlow node renderer: connection handles + the modality body.
   * @param props - ReactFlow node props; `data` carries the node's NodeView.
   * @returns The wrapped node element.
   */
  function FlowNode(props: NodeProps): React.JSX.Element {
    const data = props.data as unknown as NodeView;
    return (
      <div className='relative'>
        <Handle
          type='target'
          position={Position.Left}
          className='!h-2 !w-2 !border-border !bg-muted'
        />
        <Inner data={data} selected={props.selected} locked={data.locked} />
        <Handle
          type='source'
          position={Position.Right}
          className='!h-2 !w-2 !border-border !bg-muted'
        />
      </div>
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
