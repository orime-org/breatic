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
        <CanvasActionsContext.Provider value={{ renameNode, deleteEdge: () => undefined, activateNodeUpload: () => undefined, setNodeContent: () => undefined, commitGroupResize: () => undefined, retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}>
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
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent, commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}
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
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn(), commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}
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
      // The neutral 8px dot moved into an ::after pseudo when the handle
      // element grew into a 24px invisible hot zone (batch-2 item 10): the
      // ELEMENT is transparent (it is pure hit target), the DOT keeps the
      // original neutral border-border / bg-muted pair.
      expect(handle.className).toContain('!bg-transparent');
      expect(handle.className).toContain('after:border-border');
      expect(handle.className).toContain('after:bg-muted');
      expect(handle.className).not.toContain('!bg-background');
    });
  });

  // Bug 7: a Group is a container (Figma-Frame-style), not an edge endpoint —
  // it must render NO connection handles. The generic wrapper paints Left/Right
  // handles for content nodes; for a group they are wrong (you don't draw a
  // scissor edge to a frame) and the Left handle sat on the group's left edge,
  // interfering with the left resize grab.
  it('renders NO connection handles for a group node (Bug 7)', () => {
    const Group = FLOW_NODE_TYPES.group;
    const data = {
      kind: 'group',
      name: 'G',
      groupMinWidth: 40,
      groupMinHeight: 40,
    };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn(), commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}
        >
          <Group {...({ id: 'g1', data, selected: true } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__handle').length).toBe(0);
  });

  it('renders NO resize controls for a selected group with empty bounds (read-only viewer)', () => {
    const Group = FLOW_NODE_TYPES.group;
    // A read-only viewer gets groupResizeBounds: [] (CanvasSpace renderNodes),
    // so the group shows no resize handles even though it is selected.
    const data = { kind: 'group', name: 'G', groupResizeBounds: [] };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn(), commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}
        >
          <Group {...({ id: 'g1', data, selected: true } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__resize-control').length).toBe(0);
  });

  it('renders resize controls for a selected unlocked group that has bounds (editor)', () => {
    const Group = FLOW_NODE_TYPES.group;
    const bounds = [
      'right', 'left', 'bottom', 'top',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
    ].map((position) => ({ position, minWidth: 40, minHeight: 40 }));
    const data = { kind: 'group', name: 'G', groupResizeBounds: bounds };
    const { container } = render(
      <ReactFlowProvider>
        <CanvasActionsContext.Provider
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn(), commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}
        >
          <Group {...({ id: 'g1', data, selected: true } as unknown as NodeProps)} />
        </CanvasActionsContext.Provider>
      </ReactFlowProvider>,
    );
    expect(container.querySelectorAll('.react-flow__resize-control').length).toBe(8);
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
        <CanvasActionsContext.Provider value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload: vi.fn(), setNodeContent: vi.fn(), commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}>
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
          value={{ renameNode: vi.fn(), deleteEdge: vi.fn(), activateNodeUpload, setNodeContent: vi.fn(), commitGroupResize: vi.fn(), retryNodeUpload: vi.fn(), hasUploadRetryFile: () => false, }}
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
