// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';

import { CanvasActionsContext } from '@web/spaces/canvas/canvas-actions';
import { FLOW_NODE_TYPES } from '@web/spaces/canvas/nodes/flow-node-types';
import { NODE_KIND_LIST } from '@web/spaces/canvas/nodes/registry';
import type { TextNodeView } from '@web/spaces/canvas/types/node-view';

describe('FLOW_NODE_TYPES', () => {
  it('exposes a ReactFlow component for every node kind', () => {
    NODE_KIND_LIST.forEach((kind) => {
      expect(typeof FLOW_NODE_TYPES[kind]).toBe('function');
    });
  });

  it('keys match the registry kind list exactly', () => {
    expect(Object.keys(FLOW_NODE_TYPES).sort()).toEqual(
      [...NODE_KIND_LIST].sort(),
    );
  });

  // Critical path (collaborative rename): the flow wrapper is the only layer
  // that knows ReactFlow's node id, so it must bind the header's rename to
  // `renameNode(thisNodeId, name)`. Proves the id reaches the canvas action.
  it('binds the name header rename to the node id via CanvasActions', () => {
    const renameNode = vi.fn();
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      content: 'x',
      status: 'idle',
      name: 'Old',
    };
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider value={{ renameNode }}>
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    fireEvent.doubleClick(screen.getByTestId('node-header-name'));
    const input = screen.getByTestId('node-header-input');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(renameNode).toHaveBeenCalledWith('n1', 'Renamed');
  });
});
