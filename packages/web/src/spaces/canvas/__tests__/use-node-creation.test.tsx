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
});
