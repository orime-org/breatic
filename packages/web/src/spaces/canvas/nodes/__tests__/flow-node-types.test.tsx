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
        <CanvasActionsContext.Provider value={{ renameNode, deleteEdge: () => undefined, activateNodeUpload: () => undefined, setNodeContent: () => undefined }}>
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

  // Critical path (collaborative text edit → Yjs write): the flow wrapper is the
  // only layer that knows the node id, so it must bind the text body's inline-edit
  // commit to setNodeContent(thisNodeId, text). Without this wire the body's
  // onChange is undefined, what the user types is never persisted, and it is
  // discarded on blur — the reported #1470 "text content disappears" bug.
  it('binds the text body inline-edit commit to the node id via CanvasActions (#1470)', () => {
    const setNodeContent = vi.fn();
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      content: 'A',
      status: 'idle',
      name: 'N',
    };
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent }}
        >
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    const body = screen.getByTestId('text-node-body');
    fireEvent.doubleClick(body);
    body.innerText = 'A edited';
    fireEvent.blur(body);
    // The node id must reach the canvas write (jsdom innerText is layout-flaky,
    // so we assert the binding — call + node id — not the exact text).
    expect(setNodeContent).toHaveBeenCalled();
    expect(setNodeContent.mock.calls[0]?.[0]).toBe('n1');
  });

  // Both connection handles must paint ABOVE the node body, else the one
  // rendered BEFORE the body has its inner half covered by the body's surface
  // and reads as a half-circle (the reported left-handle bug). Absolutely-
  // positioned siblings paint in DOM order, so both handles must come AFTER the
  // body. Also pins the handle styling back to the original neutral dot.
  it('renders both handles after the node body (painted on top) in the original neutral style (#1)', () => {
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      content: 'hello',
      status: 'idle',
      name: 'N',
    };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn() }}
        >
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    const handles = container.querySelectorAll('.react-flow__handle');
    expect(handles.length).toBe(2);
    const body = screen.getByTestId('text-node');
    handles.forEach((handle) => {
      // FOLLOWING is set when `handle` comes after `body` in document order.
      expect(
        body.compareDocumentPosition(handle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Original neutral dot restored (reverses the higher-contrast patch).
      expect(handle.className).toContain('!border-border');
      expect(handle.className).toContain('!bg-muted');
      expect(handle.className).not.toContain('!bg-background');
    });
  });

  // The wrapper is the only layer with the ReactFlow store, so it must feed
  // the canvas zoom down so the name header can counter-scale to a constant
  // screen size. Proves the counter-scaled anchor is wired for content nodes.
  it('feeds the canvas zoom so the content node renders a counter-scaled header anchor', () => {
    const Text = FLOW_NODE_TYPES.text;
    const data: TextNodeView = {
      kind: 'text',
      content: 'x',
      status: 'idle',
      name: 'Old',
    };
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn() }}>
          <Text {...({ id: 'n1', data, selected: false } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    const anchor = screen.getByTestId('node-header-anchor');
    expect(anchor.style.transform).toContain('scale(');
  });

  // Empty media node double-click = open the canvas file picker for THIS node.
  // The wrapper is the only layer that knows the node id + modality, so it binds
  // onActivate to activateNodeUpload(id, modality) — proves the upload entry is
  // wired (the canvas owns the picker; only image / video / audio upload here).
  it('media node empty-state double-click triggers the canvas upload for THIS node + modality', () => {
    const activateNodeUpload = vi.fn();
    const Image = FLOW_NODE_TYPES.image;
    render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload, setNodeContent: vi.fn() }}
        >
          <Image
            {...({
              id: 'n1',
              data: { kind: 'image', content: '', status: 'idle', name: 'N' },
              selected: false,
            } as unknown as NodeProps)}
          />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    fireEvent.doubleClick(screen.getByTestId('node-placeholder'));
    expect(activateNodeUpload).toHaveBeenCalledWith('n1', 'image');
  });
});
