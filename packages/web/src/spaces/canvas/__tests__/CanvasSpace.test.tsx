// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

// Mock the Yjs binding so the component test never opens a real WebSocket
// (useCanvasSpace → useSocket → HocuspocusProvider). The write helpers
// (addEdge / removeNode / setNodePosition / addNode) keep their real
// implementations so we can spy on the actual write path.
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { serializeNodes } from '@web/spaces/canvas/node-clipboard';
import { useCanvasStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

/**
 * Dispatch a `paste` event on the document with a stubbed clipboard payload.
 * jsdom's ClipboardEvent doesn't populate `clipboardData`, so we attach a
 * minimal `getData` stub the canvas handler reads.
 * @param text - The `text/plain` payload the paste handler should see.
 */
function dispatchPaste(text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      getData: (type: string): string => (type === 'text/plain' ? text : ''),
    },
  });
  act(() => {
    document.dispatchEvent(event);
  });
}

describe('CanvasSpace (ReactFlow mount)', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    useCanvasStore.setState({
      pendingNodeCreate: null,
      pendingViewportCommand: null,
    });
    useCurrentUserStore.getState().setUser({
      id: 'u-1',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
    });
  });

  it('shows the empty-state hint when there are no nodes', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty')).toBeInTheDocument();
  });

  // Figma-like interaction: the left-button drag marquee-selects rather than
  // pans, so ReactFlow's pane must NOT carry the `draggable` class (which it
  // only adds when panOnDrag enables the left button).
  it('left-button drag selects instead of panning (pane is not draggable)', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    render(<CanvasSpace projectId='p' spaceId='s' />);
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    expect(pane?.className).not.toContain('draggable');
  });

  // Zoom bridge: the chrome zoom toolbar posts a command through the canvas
  // store; the canvas (which owns the ReactFlow viewport) must pick it up and
  // clear the mailbox. Proves the toolbar's buttons actually reach ReactFlow.
  it('consumes a viewport command posted by the chrome zoom toolbar', async () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    useCanvasStore.getState().requestViewportCommand('fit');
    render(<CanvasSpace projectId='p' spaceId='s' />);
    await waitFor(() =>
      expect(useCanvasStore.getState().pendingViewportCommand).toBeNull(),
    );
  });

  it('renders a node body through ReactFlow + the handle wrapper', () => {
    mockUseCanvasSpace.mockReturnValue({
      nodes: [
        {
          id: 'n1',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { kind: 'image', content: 'x.png', status: 'idle' },
        },
      ],
      edges: [],
      synced: true,
    });
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('image-node')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-empty')).not.toBeInTheDocument();
  });

  // Viewer gate (the canvas-internal backstop for the HIGH review finding):
  // a read-only canvas must drop a library create intent without ever
  // writing to Yjs. The `consumed` assertion proves the effect actually ran
  // and took the readOnly branch (not that it silently never fired).
  it('readOnly canvas drops a library create intent without writing to Yjs', async () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    useCanvasStore.getState().requestNodeCreate('image');

    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

    await waitFor(() =>
      expect(useCanvasStore.getState().pendingNodeCreate).toBeNull(),
    );
    expect(addNode).not.toHaveBeenCalled();
    addNode.mockRestore();
  });

  it('editor canvas fulfils a library create intent (writes via addNode)', async () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    useCanvasStore.getState().requestNodeCreate('image');

    render(<CanvasSpace projectId='p' spaceId='s' />);

    await waitFor(() => expect(addNode).toHaveBeenCalledTimes(1));
    expect(addNode.mock.calls[0][2].type).toBe('image');
    addNode.mockRestore();
  });

  it('paste plain text creates a text node carrying the pasted text', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' />);

    dispatchPaste('hello from clipboard');

    expect(addNode).toHaveBeenCalledTimes(1);
    const node = addNode.mock.calls[0][2];
    expect(node.type).toBe('text');
    expect(node.data.content).toBe('hello from clipboard');
    addNode.mockRestore();
  });

  it('paste a marked node payload clones the node (offset +24), not a text node', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' />);

    dispatchPaste(
      serializeNodes([
        { type: 'image', position: { x: 10, y: 20 }, name: 'Hero', content: 'a.png' },
      ]),
    );

    expect(addNode).toHaveBeenCalledTimes(1);
    const node = addNode.mock.calls[0][2];
    expect(node.type).toBe('image');
    expect(node.data.content).toBe('a.png');
    expect(node.position).toEqual({ x: 34, y: 44 });
    addNode.mockRestore();
  });

  it('readOnly canvas ignores paste (no Yjs write)', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

    dispatchPaste('text while read-only');

    expect(addNode).not.toHaveBeenCalled();
    addNode.mockRestore();
  });

  it('paste while a field is focused is left to the browser (no node created)', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    dispatchPaste('text into the input');

    expect(addNode).not.toHaveBeenCalled();
    input.remove();
    addNode.mockRestore();
  });
});
