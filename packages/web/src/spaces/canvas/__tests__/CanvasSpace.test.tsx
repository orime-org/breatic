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

let undoSpy: ReturnType<typeof vi.fn>;
let redoSpy: ReturnType<typeof vi.fn>;

/**
 * Build a full `useCanvasSpace` return, defaulting the undo controls so each
 * test only states the fields it cares about.
 * @param over - Partial overrides (nodes / edges / canUndo / canRedo).
 * @returns The mocked hook return value.
 */
function mockSpace(
  over: Partial<ReturnType<typeof canvasSpace.useCanvasSpace>> = {},
): ReturnType<typeof canvasSpace.useCanvasSpace> {
  return {
    nodes: [],
    edges: [],
    undo: undoSpy,
    redo: redoSpy,
    canUndo: false,
    canRedo: false,
    ...over,
  };
}

/**
 * Dispatch a `keydown` on the document so the canvas history shortcut handler
 * (a document-level listener) sees it.
 * @param key - The `KeyboardEvent.key` value.
 * @param mods - Modifier flags (meta = mac Cmd, ctrl = windows Ctrl).
 */
function dispatchKeyDown(
  key: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
): void {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

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
    undoSpy = vi.fn();
    redoSpy = vi.fn();
    useCanvasStore.setState({
      pendingNodeCreate: null,
      pendingViewportCommand: null,
      pendingHistoryCommand: null,
      canUndo: false,
      canRedo: false,
    });
    useCurrentUserStore.getState().setUser({
      id: 'u-1',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
    });
  });

  it('shows the empty-state hint when there are no nodes', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty')).toBeInTheDocument();
  });

  // Figma-like interaction: the left-button drag marquee-selects rather than
  // pans, so ReactFlow's pane must NOT carry the `draggable` class (which it
  // only adds when panOnDrag enables the left button).
  it('left-button drag selects instead of panning (pane is not draggable)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    render(<CanvasSpace projectId='p' spaceId='s' />);
    const pane = document.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    expect(pane?.className).not.toContain('draggable');
  });

  // Zoom bridge: the chrome zoom toolbar posts a command through the canvas
  // store; the canvas (which owns the ReactFlow viewport) must pick it up and
  // clear the mailbox. Proves the toolbar's buttons actually reach ReactFlow.
  it('consumes a viewport command posted by the chrome zoom toolbar', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    useCanvasStore.getState().requestViewportCommand('fit');
    render(<CanvasSpace projectId='p' spaceId='s' />);
    await waitFor(() =>
      expect(useCanvasStore.getState().pendingViewportCommand).toBeNull(),
    );
  });

  it('renders a node body through ReactFlow + the handle wrapper', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('image-node')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-empty')).not.toBeInTheDocument();
  });

  // Viewer drag backstop (#1377). A read-only viewer must not be able to drag
  // nodes: ReactFlow gates dragging via `nodesDraggable`, and when false it
  // omits the `draggable` class from the node wrapper (the drag handler is
  // disabled too). The real security boundary is the collab server — a
  // read-only connection rejects the viewer's Yjs update — but gating the UI
  // here stops the confusing "move locally then snap back" once the server
  // rejects, and stops accidental edits.
  it('readOnly canvas renders nodes as non-draggable (ReactFlow omits the draggable class)', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);
    const node = document.querySelector('.react-flow__node');
    expect(node).not.toBeNull();
    expect(node?.className).not.toContain('draggable');
  });

  it('editor canvas renders nodes as draggable', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace({
        nodes: [
          {
            id: 'n1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { kind: 'image', content: 'x.png', status: 'idle' },
          },
        ],
      }),
    );
    render(<CanvasSpace projectId='p' spaceId='s' />);
    const node = document.querySelector('.react-flow__node');
    expect(node).not.toBeNull();
    expect(node?.className).toContain('draggable');
  });

  // Viewer gate (the canvas-internal backstop for the HIGH review finding):
  // a read-only canvas must drop a library create intent without ever
  // writing to Yjs. The `consumed` assertion proves the effect actually ran
  // and took the readOnly branch (not that it silently never fired).
  it('readOnly canvas drops a library create intent without writing to Yjs', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
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
    mockUseCanvasSpace.mockReturnValue(mockSpace());
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
    mockUseCanvasSpace.mockReturnValue(mockSpace());
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
    mockUseCanvasSpace.mockReturnValue(mockSpace());
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
    mockUseCanvasSpace.mockReturnValue(mockSpace());
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

    dispatchPaste('text while read-only');

    expect(addNode).not.toHaveBeenCalled();
    addNode.mockRestore();
  });

  it('paste while a field is focused is left to the browser (no node created)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace());
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

  // ---- History bridge (undo / redo) ----

  it('mirrors the hook undo availability into the canvas store (canvas → chrome)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: false }));
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(useCanvasStore.getState().canUndo).toBe(true);
    expect(useCanvasStore.getState().canRedo).toBe(false);
  });

  it('consumes an undo command posted by the chrome toolbar (chrome → canvas mailbox)', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    useCanvasStore.getState().requestHistoryCommand('undo');
    render(<CanvasSpace projectId='p' spaceId='s' />);
    await waitFor(() =>
      expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull(),
    );
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(redoSpy).not.toHaveBeenCalled();
  });

  it('Cmd+Z (mac) triggers undo; Cmd+Shift+Z triggers redo', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: true }));
    render(<CanvasSpace projectId='p' spaceId='s' />);

    dispatchKeyDown('z', { meta: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    dispatchKeyDown('z', { meta: true, shift: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+Z (windows) triggers undo; Ctrl+Y triggers redo', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true, canRedo: true }));
    render(<CanvasSpace projectId='p' spaceId='s' />);

    dispatchKeyDown('z', { ctrl: true });
    expect(undoSpy).toHaveBeenCalledTimes(1);

    dispatchKeyDown('y', { ctrl: true });
    expect(redoSpy).toHaveBeenCalledTimes(1);
  });

  it('keyboard undo is a no-op while a field is focused (input native undo wins)', () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    render(<CanvasSpace projectId='p' spaceId='s' />);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    dispatchKeyDown('z', { meta: true });

    expect(undoSpy).not.toHaveBeenCalled();
    input.remove();
  });

  it('readOnly canvas ignores keyboard undo and posted history commands', async () => {
    mockUseCanvasSpace.mockReturnValue(mockSpace({ canUndo: true }));
    useCanvasStore.getState().requestHistoryCommand('undo');
    render(<CanvasSpace projectId='p' spaceId='s' readOnly />);

    await waitFor(() =>
      expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull(),
    );
    dispatchKeyDown('z', { meta: true });

    expect(undoSpy).not.toHaveBeenCalled();
  });
});
