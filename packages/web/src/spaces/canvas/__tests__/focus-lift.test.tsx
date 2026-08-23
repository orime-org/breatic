// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
 * Mounts the canvas with a fresh query client (the space prefetches the model
 * catalog on mount).
 * @returns The render result.
 */
function renderSpace(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CanvasSpace projectId='p' spaceId='s' readOnly={false} />
    </QueryClientProvider>,
  );
}

/**
 * Reads the inline z-index xyflow wrote onto a node element.
 * @param id - The node id.
 * @returns The element's z-index string.
 */
function zOf(id: string): string {
  const el = document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  );
  if (!el) throw new Error(`node ${id} is not rendered`);
  return el.style.zIndex;
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

type Nodes = ReturnType<typeof canvasSpace.useCanvasSpace>['nodes'];

const IMAGE = (id: string, x: number, over = {}): Nodes[number] =>
  ({
    id,
    type: 'image',
    position: { x, y: 0 },
    data: { kind: 'image', content: `${id}.png`, status: 'idle', ...over },
  }) as Nodes[number];

describe('聚焦目标的抬升（#2000）', () => {
  beforeEach(() => {
    mockUseCanvasSpace.mockReset();
    useCanvasStore.setState({ pickSession: null });
  });

  it('A1：点中聚焦源之后，它带 zIndex 1002', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300)]),
    );
    renderSpace();
    expect(zOf('src')).toBe('0');

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');

    expect(screen.getByTestId('focus-crop-overlay')).toBeInTheDocument();
    expect(zOf('src')).toBe('1002');
  });

  it('A2：1002 高于一个被选中的节点（选中加成是 1000）', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('other', 300), IMAGE('src', 600)]),
    );
    renderSpace();
    // Select `other` while selection is still live (before the pick starts):
    // xyflow gives a selected node SELECTED_NODE_Z, i.e. 1000.
    clickNode('other');
    expect(zOf('other')).toBe('1000');

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');

    expect(Number(zOf('src'))).toBeGreaterThan(Number(zOf('other')));
  });

  it('A2：1002 高于一个组成员', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        IMAGE('host', 0),
        {
          id: 'g',
          type: 'group',
          position: { x: 300, y: 0 },
          width: 400,
          height: 400,
          data: { kind: 'group' },
        } as Nodes[number],
        { ...IMAGE('member', 20), parentId: 'g' } as Nodes[number],
        IMAGE('src', 900),
      ]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');

    expect(Number(zOf('src'))).toBeGreaterThan(Number(zOf('member')));
  });

  it('A2：1002 高于一个被选中的组的成员（父链把它推到 1001）', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([
        IMAGE('host', 0),
        {
          id: 'g',
          type: 'group',
          position: { x: 300, y: 0 },
          width: 400,
          height: 400,
          data: { kind: 'group' },
        } as Nodes[number],
        { ...IMAGE('member', 20), parentId: 'g' } as Nodes[number],
        IMAGE('src', 900),
      ]),
    );
    renderSpace();
    // A selected group is 1000; calculateChildXYZ then gives its member
    // parentZ + 1. That 1001 is the tallest a node reaches, since groups
    // cannot nest — it is the number 1002 was chosen against.
    clickNode('g');
    expect(zOf('g')).toBe('1000');
    expect(zOf('member')).toBe('1001');

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');

    expect(Number(zOf('src'))).toBeGreaterThan(Number(zOf('member')));
  });

  it('A3：回到挑选态之后 zIndex 回到原值（确认 / 取消 / Esc 共用这条路）', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300)]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe('1002');

    // Confirm, Cancel and the overlay's bare Esc share backToPick, which
    // drops the crop target and leaves the session running — the banner
    // stays. Esc is the one reachable here: the controls bar renders off a
    // measured source box, and jsdom gives images no size.
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(zOf('src')).toBe('0');
    expect(screen.getByTestId('reference-pick-banner')).toBeInTheDocument();
  });

  it('A3：会话换 purpose 之后 zIndex 回到原值', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300)]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe('1002');

    act(() => useCanvasStore.getState().startStylePick('host'));
    expect(zOf('src')).toBe('0');
  });

  it('A3：换聚焦目标时，旧的落回原层、新的抬起来', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('a', 300), IMAGE('b', 600)]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('a');
    expect(zOf('a')).toBe('1002');

    clickNode('b');
    expect(zOf('a')).toBe('0');
    expect(zOf('b')).toBe('1002');
  });

  it('A3：退出聚焦后 zIndex 回到原值', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300)]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');
    expect(zOf('src')).toBe('1002');

    act(() => useCanvasStore.getState().endPick());
    expect(zOf('src')).toBe('0');
  });

  it('A4：本功能不写 selected —— 聚焦目标不带 selected class', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300)]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');

    const el = document.querySelector('.react-flow__node[data-id="src"]')!;
    expect(el.className).not.toContain('selected');
  });

  it('A5：聚焦目标是锁定节点时，抬起来了但仍不可拖', () => {
    mockUseCanvasSpace.mockReturnValue(
      mockSpace([IMAGE('host', 0), IMAGE('src', 300, { locked: true })]),
    );
    renderSpace();

    act(() => useCanvasStore.getState().startFocusPick('host'));
    clickNode('src');

    expect(zOf('src')).toBe('1002');
    const el = document.querySelector('.react-flow__node[data-id="src"]')!;
    expect(el.className).not.toContain('draggable');
  });
});
