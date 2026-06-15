// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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
import { useCanvasStore } from '@web/stores';

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

describe('CanvasSpace (ReactFlow mount)', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    useCanvasStore.setState({ pendingNodeCreate: null });
  });

  it('shows the empty-state hint when there are no nodes', () => {
    mockUseCanvasSpace.mockReturnValue({ nodes: [], edges: [], synced: true });
    render(<CanvasSpace projectId='p' spaceId='s' />);
    expect(screen.getByTestId('canvas-space')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-empty')).toBeInTheDocument();
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
});
