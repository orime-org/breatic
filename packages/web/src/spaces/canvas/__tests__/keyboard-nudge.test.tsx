// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import {
  addNode,
  createGroup,
  setNodeName,
  getCanvasUndoManager,
  readNodes,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { createGroupNode } from '@web/spaces/canvas/node-factory';
import { GROUP_PADDING } from '@web/spaces/canvas/group-geometry';
import { useCanvasStore, useUIStore } from '@web/stores';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { canvasGraphs } from '@web/stores/canvas-graph';
import {
  clickNode,
  mockSpace,
  renderSpace,
} from '@web/spaces/canvas/__tests__/focus-harness';

vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(
    (): ReturnType<typeof import('@web/data/yjs/use-socket').useSocket> => ({
      provider: null,
      synced: false,
      hasEverSynced: false,
      status: 'connecting',
      writeAccess: 'unknown',
      authFailedReason: null,
    }),
  ),
}));
vi.mock('@web/data/yjs/space-connection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/space-connection')>();
  const { useSocket } = await import('@web/data/yjs/use-socket');
  return {
    ...actual,
    // The body reads the connection its tab holds; here that is whatever the
    // `useSocket` stub above answers.
    useSpaceConnection: () => useSocket({ name: '', doc: undefined as never }),
  };
});


const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

const NAME = docName.canvasSpace('p', 's');

/**
 * The canvas document every write in this file lands in.
 * @returns The document.
 */
function doc(): ReturnType<typeof getDoc> {
  return getDoc(NAME);
}

/**
 * Where the document has a node.
 * @param id - The node id.
 * @returns The stored position and parent.
 * @throws {Error} When the node is not in the document.
 */
function stored(id: string): { x: number; y: number; parentId?: string } {
  const node = readNodes(doc()).find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} is not in the document`);
  return { ...node.position, parentId: node.parentId };
}

/**
 * Writes an image node into the document.
 * @param id - The node id.
 * @param x - Its x position.
 * @param y - Its y position.
 */
function seedImage(id: string, x: number, y: number, locked = false): void {
  seed('image', id, x, y, { locked, content: `${id}.png` });
}

/**
 * Writes a node of any kind into the document.
 * @param type - The node kind.
 * @param id - The node id.
 * @param x - Its x position.
 * @param y - Its y position.
 * @param data - Data fields beyond the ones every node carries.
 */
function seed(
  type: 'image' | 'audio' | 'video' | 'text',
  id: string,
  x: number,
  y: number,
  data: Record<string, unknown> = {},
): void {
  addNode('p', 's', {
    id,
    type,
    position: { x, y },
    data: {
      name: id,
      createdAt: 1,
      createdBy: 'u',
      locked: false,
      attachments: [],
      ...data,
    },
  });
}

/**
 * Seeds a 400x300 Group at (100, 100) holding one image member.
 * @param memberAt - The member's position inside the Group.
 */
function seedGroup(memberAt: { x: number; y: number }): void {
  seedImage('m', 0, 0);
  createGroup(
    'p',
    's',
    createGroupNode('g', { x: 100, y: 100 }, 400, 300, 'u'),
    [{ id: 'm', position: memberAt }],
  );
}

/**
 * The Group's stored width.
 * @returns The width in its data.
 */
function groupWidth(): unknown {
  const g = readNodes(doc()).find((n) => n.id === 'g');
  return (g?.data as { width?: number } | undefined)?.width;
}

/**
 * Selects several nodes at once, the way a marquee leaves them.
 * @param ids - The node ids to select.
 */
function selectAll(ids: ReadonlyArray<string>): void {
  const picked = new Set(ids);
  act(() => {
    canvasGraphs.of('s').getState()
      .setFlowNodes((prev) =>
        prev.map((n) => ({ ...n, selected: picked.has(n.id) })),
      );
  });
}

/**
 * Mounts the canvas on what the document holds.
 */
function mount(): void {
  mockUseCanvasSpace.mockReturnValue(mockSpace([...readNodes(doc())], true));
  renderSpace();
}

/**
 * Mounts the canvas read-only, as a viewer sees it.
 */
function mountReadOnly(): void {
  mockUseCanvasSpace.mockReturnValue(mockSpace([...readNodes(doc())], true));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <div data-region='space'>
        <CanvasSpace projectId='p' spaceId='s' readOnly />
      </div>
    </QueryClientProvider>,
  );
}

/**
 * The element xyflow renders for a node.
 * @param id - The node id.
 * @returns The node wrapper.
 */
function shell(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  )!;
}

/**
 * Presses a key on a node wrapper, which is where focus sits after a click.
 * @param id - The node id.
 * @param key - The key.
 * @param shiftKey - Whether Shift is held.
 */
function press(id: string, key: string, shiftKey = false, repeat = false): void {
  act(() => {
    fireEvent.keyDown(shell(id), { key, shiftKey, repeat });
  });
}

describe('arrow keys move the selected nodes in the document (inner#1010)', () => {
  beforeEach(() => {
    _resetForTests();
    _resetCanvasUndoCacheForTests();
    mockUseCanvasSpace.mockReset();
    useUIStore.setState({ activeRegion: 'space' });
    useCanvasStore.setState({ snapToGrid: false });
  });

  it('B1: a nudge on a selected node lands in the document', async () => {
    seedImage('a', 100, 100);
    mount();
    clickNode('a');
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 105, y: 100 }));
  });

  it('B3: Shift takes the large step', async () => {
    seedImage('a', 100, 100);
    mount();
    clickNode('a');
    press('a', 'ArrowDown', true);
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 100, y: 120 }));
  });

  it('B4: each press is its own undo step and undo puts the node back', async () => {
    seedImage('a', 100, 100);
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a').x).toBe(105));
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a').x).toBe(110));
    expect(undo.undoStack.length).toBe(before + 2);
    act(() => {
      undo.undo();
    });
    expect(stored('a').x).toBe(105);
  });

  it('B5: a nudged Group moves whole, keeping its size and its members', async () => {
    seedGroup({ x: GROUP_PADDING, y: GROUP_PADDING });
    mount();
    clickNode('g');
    press('g', 'ArrowRight');
    await waitFor(() => expect(stored('g')).toMatchObject({ x: 105, y: 100 }));
    const g = readNodes(doc()).find((n) => n.id === 'g')!;
    expect(g.data).toMatchObject({ width: 400, height: 300 });
    expect(stored('m')).toEqual({
      x: GROUP_PADDING,
      y: GROUP_PADDING,
      parentId: 'g',
    });
  });

  it('an arrow key with the keyboard on the page moves the selected nodes (inner#1349 A12)', async () => {
    seedImage('a', 100, 100);
    seedImage('b', 400, 100);
    mount();
    selectAll(['a']);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    });
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 105, y: 100 }));
    expect(stored('b')).toMatchObject({ x: 400, y: 100 });
  });

  it('an arrow key with the keyboard on the canvas itself moves the selected nodes', async () => {
    seedImage('a', 100, 100);
    mount();
    selectAll(['a']);
    act(() => {
      fireEvent.keyDown(document.querySelector('[data-testid="canvas-space"]') as HTMLElement, { key: 'ArrowRight' });
    });
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 105, y: 100 }));
  });

  it('an arrow key on the selection box xyflow focuses after a marquee moves the selected nodes', async () => {
    seedImage('a', 100, 100);
    mount();
    selectAll(['a']);
    // xyflow focuses this inner box once a marquee leaves a selection.
    const box = document.createElement('div');
    box.className = 'react-flow__nodesselection-rect';
    box.tabIndex = -1;
    document.querySelector('[data-testid="canvas-space"]')?.append(box);
    act(() => {
      fireEvent.keyDown(box, { key: 'ArrowRight' });
    });
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 105, y: 100 }));
    box.remove();
  });

  it('an arrow key on the page leaves the nodes alone while another region has the keyboard', () => {
    seedImage('a', 100, 100);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    selectAll(['a']);
    useUIStore.setState({ activeRegion: 'agent' });
    act(() => {
      fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    });
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('an arrow key in a field outside the canvas leaves the selected nodes alone', () => {
    seedImage('a', 100, 100);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    selectAll(['a']);
    const field = document.createElement('textarea');
    document.body.append(field);
    act(() => {
      fireEvent.keyDown(field, { key: 'ArrowRight' });
    });
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    field.remove();
    write.mockRestore();
  });

  it('an arrow key on a node that is not selected writes nothing', () => {
    seedImage('a', 100, 100);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    press('a', 'ArrowRight');
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('B4: holding a key down is one undo step for the whole move', async () => {
    seedImage('a', 100, 100);
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    press('a', 'ArrowRight');
    press('a', 'ArrowRight', false, true);
    press('a', 'ArrowRight', false, true);
    press('a', 'ArrowRight', false, true);
    await waitFor(() => expect(stored('a').x).toBe(120));
    expect(undo.undoStack.length).toBe(before + 1);
    act(() => {
      undo.undo();
    });
    expect(stored('a').x).toBe(100);
  });

  it('B4: a fresh press after a held one starts a new undo step', async () => {
    seedImage('a', 100, 100);
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    press('a', 'ArrowRight');
    press('a', 'ArrowRight', false, true);
    press('a', 'ArrowDown');
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 110, y: 105 }));
    expect(undo.undoStack.length).toBe(before + 2);
    act(() => {
      undo.undo();
    });
    expect(stored('a')).toMatchObject({ x: 110, y: 100 });
  });

  it('B4: repeats with no opening press of their own start a new undo step', async () => {
    // The manager exists first, so creating the node is the step on top.
    const undo = getCanvasUndoManager(doc(), NAME);
    seedImage('a', 100, 100);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    // Focus reached the node while the key was already held: only repeats arrive.
    press('a', 'ArrowRight', false, true);
    press('a', 'ArrowRight', false, true);
    await waitFor(() => expect(stored('a').x).toBe(110));
    expect(undo.undoStack.length).toBe(before + 1);
    act(() => {
      undo.undo();
    });
    expect(stored('a')).toMatchObject({ x: 100, y: 100 });
  });

  it('B4: a held run does not swallow a write made in the middle of it', async () => {
    seedImage('a', 100, 100);
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a').x).toBe(105));
    act(() => {
      setNodeName('p', 's', 'a', 'renamed');
    });
    press('a', 'ArrowRight', false, true);
    await waitFor(() => expect(stored('a').x).toBe(110));
    expect(undo.undoStack.length).toBe(before + 3);
    act(() => {
      undo.undo();
    });
    expect(stored('a').x).toBe(105);
    expect(readNodes(doc()).find((n) => n.id === 'a')?.data).toMatchObject({ name: 'renamed' });
  });

  it('B4: pressing the pointer ends the held run', async () => {
    seedImage('a', 100, 100);
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a').x).toBe(105));
    act(() => {
      fireEvent.pointerDown(document.querySelector('.react-flow__pane') as HTMLElement);
    });
    press('a', 'ArrowRight', false, true);
    await waitFor(() => expect(stored('a').x).toBe(110));
    expect(undo.undoStack.length).toBe(before + 2);
  });

  it('B4: a fresh press that moves nothing still ends the previous held run', async () => {
    seedImage('a', 100, 100);
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('a');
    const before = undo.undoStack.length;
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a').x).toBe(105));
    // A fresh press xyflow does not act on: the node is not selected for it.
    selectAll([]);
    press('a', 'ArrowRight');
    selectAll(['a']);
    press('a', 'ArrowRight', false, true);
    await waitFor(() => expect(stored('a').x).toBe(110));
    expect(undo.undoStack.length).toBe(before + 2);
    act(() => {
      undo.undo();
    });
    expect(stored('a').x).toBe(105);
  });

  it('B3: with snap to grid on, a press steps one grid dot and lands on the grid', async () => {
    seedImage('a', 100, 100);
    useCanvasStore.setState({ snapToGrid: true });
    mount();
    clickNode('a');
    press('a', 'ArrowRight');
    await waitFor(() => expect(stored('a')).toMatchObject({ x: 120, y: 96 }));
  });

  it('B5: a member nudged past its Group edge grows the Group, one undo step', async () => {
    // EMPTY_NODE_SIZE is 288 wide, so x=88 puts the member's right edge on the padding line.
    seedGroup({ x: 88, y: GROUP_PADDING });
    const undo = getCanvasUndoManager(doc(), NAME);
    mount();
    clickNode('m');
    const before = undo.undoStack.length;
    press('m', 'ArrowRight', true);
    await waitFor(() => expect(groupWidth()).toBe(420));
    expect(stored('m')).toEqual({ x: 108, y: GROUP_PADDING, parentId: 'g' });
    expect(stored('g')).toMatchObject({ x: 100, y: 100 });
    expect(undo.undoStack.length).toBe(before + 1);
    act(() => {
      undo.undo();
    });
    expect(groupWidth()).toBe(400);
    expect(stored('m').x).toBe(88);
  });

  it('B6: a read-only canvas neither moves nor writes', () => {
    seedImage('a', 100, 100);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mountReadOnly();
    clickNode('a');
    press('a', 'ArrowRight');
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('arrow keys while typing in a text node leave the node where it is', async () => {
    seed('text', 't', 100, 100);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    clickNode('t');
    act(() => {
      fireEvent.keyDown(shell('t'), { key: 'Enter' });
    });
    await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull());
    act(() => {
      fireEvent.keyDown(document.querySelector('.ProseMirror') as HTMLElement, {
        key: 'ArrowRight',
      });
    });
    expect(shell('t').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('B5: with a Group and its member both selected, only the Group is written', async () => {
    seedGroup({ x: GROUP_PADDING, y: GROUP_PADDING });
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    selectAll(['g', 'm']);
    press('g', 'ArrowRight');
    await waitFor(() => expect(stored('g').x).toBe(105));
    expect(write.mock.calls.map((call) => call[2])).toEqual(['g']);
    write.mockRestore();
  });

  it('B6: a locked node neither moves nor writes', () => {
    seedImage('a', 100, 100, true);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    clickNode('a');
    press('a', 'ArrowRight');
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('B8: arrow keys on a video seek bar leave the node where it is', () => {
    seed('video', 'v', 100, 100, { content: 'v.mp4' });
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    clickNode('v');
    const thumb = shell('v').querySelector<HTMLElement>('[role="slider"]')!;
    act(() => {
      fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    });
    expect(shell('v').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('B8: arrow keys on the volume slider leave the node where it is', async () => {
    seed('audio', 'a', 100, 100, { content: 'a.mp3' });
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    clickNode('a');
    act(() => {
      fireEvent.click(shell('a').querySelector('[data-testid="volume-button"]')!);
    });
    await waitFor(() =>
      expect(document.querySelector('[data-testid="volume"] [role="slider"]')).not.toBeNull(),
    );
    act(() => {
      fireEvent.keyDown(
        document.querySelector('[data-testid="volume"] [role="slider"]') as HTMLElement,
        { key: 'ArrowDown' },
      );
    });
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('B8: arrow keys on an audio seek bar leave the node where it is', () => {
    addNode('p', 's', {
      id: 'a',
      type: 'audio',
      position: { x: 100, y: 100 },
      data: {
        name: 'a',
        createdAt: 1,
        createdBy: 'u',
        locked: false,
        attachments: [],
        content: 'a.mp3',
      },
    });
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    clickNode('a');
    const thumb = shell('a').querySelector<HTMLElement>('[role="slider"]')!;
    act(() => {
      fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    });
    expect(shell('a').style.transform).toBe('translate(100px,100px)');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
