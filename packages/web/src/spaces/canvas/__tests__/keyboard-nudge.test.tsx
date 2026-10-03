// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, waitFor } from '@testing-library/react';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import {
  addNode,
  createGroup,
  getCanvasUndoManager,
  readNodes,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { createGroupNode } from '@web/spaces/canvas/node-factory';
import { GROUP_PADDING } from '@web/spaces/canvas/group-geometry';
import { useUIStore } from '@web/stores';
import { useCanvasGraphStore } from '@web/stores/canvas-graph';
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
  addNode('p', 's', {
    id,
    type: 'image',
    position: { x, y },
    data: {
      name: id,
      createdAt: 1,
      createdBy: 'u',
      locked,
      attachments: [],
      content: `${id}.png`,
    },
  });
}

/**
 * Selects several nodes at once, the way a marquee leaves them.
 * @param ids - The node ids to select.
 */
function selectAll(ids: ReadonlyArray<string>): void {
  const picked = new Set(ids);
  act(() => {
    useCanvasGraphStore
      .getState()
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
function press(id: string, key: string, shiftKey = false): void {
  act(() => {
    fireEvent.keyDown(shell(id), { key, shiftKey });
  });
}

describe('arrow keys move the selected nodes in the document (inner#1010)', () => {
  beforeEach(() => {
    _resetForTests();
    _resetCanvasUndoCacheForTests();
    mockUseCanvasSpace.mockReset();
    useUIStore.setState({ activeRegion: 'space' });
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
    seedImage('m', 0, 0);
    createGroup(
      'p',
      's',
      createGroupNode('g', { x: 100, y: 100 }, 400, 300, 'u'),
      [{ id: 'm', position: { x: GROUP_PADDING, y: GROUP_PADDING } }],
    );
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

  it('a key that moves nothing writes nothing', () => {
    seedImage('a', 100, 100);
    const write = vi.spyOn(canvasSpace, 'setNodePosition');
    mount();
    clickNode('a');
    press('a', 'Enter');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('B5: with a Group and its member both selected, only the Group is written', async () => {
    seedImage('m', 0, 0);
    createGroup(
      'p',
      's',
      createGroupNode('g', { x: 100, y: 100 }, 400, 300, 'u'),
      [{ id: 'm', position: { x: GROUP_PADDING, y: GROUP_PADDING } }],
    );
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

  it('B8: arrow keys on a media slider move the playhead, not the node', () => {
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
