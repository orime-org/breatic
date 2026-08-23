// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type * as React from 'react';

import * as canvasSpace from '@web/data/yjs/canvas-space';
import { useCanvasStore } from '@web/stores/canvas';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';

vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});

vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({
    provider: null,
    synced: true,
    status: 'connecting' as const,
  })),
}));

const mockUseCanvasSpace = vi.mocked(canvasSpace.useCanvasSpace);

type Nodes = ReturnType<typeof canvasSpace.useCanvasSpace>['nodes'];

/**
 * Builds the shape `useCanvasSpace` returns, with only nodes varying.
 * @param nodes - The canvas nodes to mirror.
 * @returns The mocked space value.
 */
function mockSpace(nodes: Nodes): ReturnType<typeof canvasSpace.useCanvasSpace> {
  return {
    nodes,
    edges: [],
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
  };
}

/**
 * Mounts the canvas and hands back a remount that re-reads the mocked space,
 * which is how a collaborator's write reaches this component.
 * @returns A remount callback.
 */
function renderSpace(): () => void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A fresh element each time: passing the same element object back to
  // rerender lets React bail out of the whole subtree, so the component would
  // never re-read the mocked space.
  const tree = (): React.ReactElement => (
    <QueryClientProvider client={client}>
      <CanvasSpace projectId='p' spaceId='s' readOnly={false} />
    </QueryClientProvider>
  );
  const r = render(tree());
  return () => {
    act(() => r.rerender(tree()));
  };
}

/**
 * Clicks a node element by id.
 * @param id - The node id.
 * @returns Nothing.
 */
function clickNode(id: string): void {
  act(() => {
    fireEvent.click(
      document.querySelector(`.react-flow__node[data-id="${id}"]`)!,
    );
  });
}

const IMAGE = (id: string, x: number, over = {}): Nodes[number] =>
  ({
    id,
    type: 'image',
    position: { x, y: 0 },
    data: { kind: 'image', content: `${id}.png`, status: 'idle', ...over },
  }) as Nodes[number];

/**
 * Puts the canvas into the focused state on `src`.
 * @param nodes - The starting nodes.
 * @returns A remount callback.
 */
function enterFocus(nodes: Nodes): () => void {
  mockUseCanvasSpace.mockReturnValue(mockSpace(nodes));
  const remount = renderSpace();
  act(() => useCanvasStore.getState().startFocusPick('host'));
  clickNode('src');
  expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  return remount;
}

const START: Nodes = [IMAGE('host', 0), IMAGE('src', 300)];

describe('远程改动聚焦目标（#2000）', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    useCanvasStore.setState({ pickSession: null });
    vi.restoreAllMocks();
  });

  it('A6：远程删除 → toast 说被删了，退回挑选横幅', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(mockSpace([IMAGE('host', 0)]));
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source deleted.');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A7：远程换内容 → toast 说换了，退回挑选横幅', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300, { content: 'other.png' })]),
    );
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source replaced.');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A8：远程让它进 handling → toast 说在生成，退回挑选横幅', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300, { status: 'handling' })]),
    );
    remount();

    expect(warn.mock.calls[0]?.[0]).toBe('Source is generating.');
    expect(screen.queryByTestId('focus-crop-overlay')).toBeNull();
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A9：远程拖动它 → 聚焦照常，一条 toast 都没有', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 900)]),
    );
    remount();

    expect(warn).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  });

  it('A9：远程把它加进组 → 聚焦照常，一条 toast 都没有', () => {
    const warn = vi.spyOn(toast, 'warning').mockReturnValue('t');
    const remount = enterFocus(START);

    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        IMAGE('host', 0),
        {
          id: 'g',
          type: 'group',
          position: { x: 280, y: 0 },
          width: 400,
          height: 400,
          data: { kind: 'group' },
        } as Nodes[number],
        { ...IMAGE('src', 20), parentId: 'g' } as Nodes[number],
      ]),
    );
    remount();

    expect(warn).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
  });
});
