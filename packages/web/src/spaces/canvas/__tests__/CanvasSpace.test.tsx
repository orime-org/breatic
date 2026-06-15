// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock the Yjs binding so the component test never opens a real WebSocket
// (useCanvasSpace → useSocket → HocuspocusProvider). The write helpers
// (addEdge / removeNode / setNodePosition) keep their real implementations.
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useCanvasSpace } from '@web/data/yjs/canvas-space';

const mockUseCanvasSpace = vi.mocked(useCanvasSpace);

describe('CanvasSpace (ReactFlow mount)', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
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
});
