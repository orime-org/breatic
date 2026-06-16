// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';

describe('useNodeCreation', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().setUser({
      id: 'u-9',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
    });
  });

  it('createNodeAt writes an empty node of the type/position via addNode and returns its id', () => {
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const id = result.current.createNodeAt('image', { x: 100, y: 200 });

    expect(addNode).toHaveBeenCalledTimes(1);
    const [projectId, spaceId, node] = addNode.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(spaceId).toBe('s1');
    expect(node.id).toBe(id);
    expect(node.type).toBe('image');
    expect(node.position).toEqual({ x: 100, y: 200 });
    expect(node.data.name).toBe('Image');
    expect(node.data.createdBy).toBe('u-9');
    addNode.mockRestore();
  });

  it('pasteTextAt writes a text node carrying the pasted text and returns its id', () => {
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const id = result.current.pasteTextAt('hello world', { x: 5, y: 6 });

    expect(addNode).toHaveBeenCalledTimes(1);
    const [, , node] = addNode.mock.calls[0];
    expect(node.id).toBe(id);
    expect(node.type).toBe('text');
    expect(node.position).toEqual({ x: 5, y: 6 });
    expect(node.data.content).toBe('hello world');
    expect(node.data.createdBy).toBe('u-9');
    addNode.mockRestore();
  });

  it('pasteNodesAt clones clipboard nodes (offset + fresh ids + carried content) and returns their ids', () => {
    const addNode = vi
      .spyOn(canvasSpace, 'addNode')
      .mockImplementation(() => undefined);
    const { result } = renderHook(() => useNodeCreation('p1', 's1'));

    const ids = result.current.pasteNodesAt(
      [
        { type: 'image', position: { x: 10, y: 20 }, name: 'Hero', content: 'a.png' },
        { type: 'text', position: { x: 30, y: 40 }, content: 'note' },
      ],
      { dx: 24, dy: 24 },
    );

    expect(addNode).toHaveBeenCalledTimes(2);
    expect(ids).toHaveLength(2);
    const first = addNode.mock.calls[0][2];
    expect(first.id).toBe(ids[0]);
    expect(first.type).toBe('image');
    expect(first.position).toEqual({ x: 34, y: 44 });
    expect(first.data.content).toBe('a.png');
    expect(first.data.name).toBe('Hero');
    expect(first.data.createdBy).toBe('u-9');
    addNode.mockRestore();
  });
});
