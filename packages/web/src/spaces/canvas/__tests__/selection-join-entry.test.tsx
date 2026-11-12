// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The multi-selection entry of the join tool (inner#1825 §6.5): a marquee
 * over two or more clips of one medium, all holding content, offers "Join"
 * above "Copy" in the selection menu, and picking it opens the join panel on
 * the first clip with every clip prefilled in canvas order.
 *
 * The canvas is mounted for real and the selection is made the way a user
 * makes it, with a marquee drag on the pane, because the menu reads what
 * ReactFlow holds as selected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';

vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return { ...actual, useCanvasSpace: vi.fn() };
});
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: false, status: 'connecting', authFailedReason: null })),
}));
vi.mock('@web/data/yjs/space-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/space-connection')>();
  const { useSocket } = await import('@web/data/yjs/use-socket');
  return { ...actual, useSpaceConnection: () => useSocket({ name: '', doc: undefined as never }) };
});
// The canvas knobs, with a join cap; every other GET is refused.
vi.mock('@web/data/api/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/api/request')>();
  return { ...actual, apiGet: vi.fn() };
});
// The app mounts the one TooltipProvider; a bare mount has none.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { canvasApi, type CanvasLimits } from '@web/data/api/canvas';
import { apiGet } from '@web/data/api/request';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { canvasGraphs } from '@web/stores/canvas-graph';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useUIStore } from '@web/stores';

type Nodes = ReturnType<typeof canvasSpace.useCanvasSpace>['nodes'];

/**
 * A clip node.
 * @param id - Its id; also the stem of its name and file.
 * @param type - Video or audio.
 * @param at - Its stored position.
 * @param over - Further data, or `content: undefined` for an empty node.
 * @returns The node view.
 */
function clip(id: string, type: 'video' | 'audio', at: { x: number; y: number }, over: Record<string, unknown> = {}): Nodes[number] {
  const ext = type === 'video' ? 'mp4' : 'mp3';
  return {
    id,
    type,
    position: at,
    data: {
      handling: false,
      name: id.toUpperCase(),
      content: `https://cdn/${id}.${ext}`,
      duration: 4,
      ...(type === 'video' ? { coverUrl: `https://cdn/${id}.jpg` } : {}),
      ...over,
    },
  } as Nodes[number];
}

/**
 * Mounts the canvas holding these nodes.
 * @param nodes - The nodes.
 * @param readOnly - Mount it read-only, as a Viewer sees it.
 */
function mount(nodes: Nodes, readOnly = false): void {
  vi.mocked(canvasSpace.useCanvasSpace).mockReturnValue({
    nodes,
    edges: [],
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: false,
    canRedo: false,
    getLastWriteWasLocal: () => true,
    deletedByPeer: () => false,
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div data-region='space'>
        <CanvasSpace projectId='p' spaceId='s' readOnly={readOnly} />
      </div>
    </QueryClientProvider>,
  );
}

/**
 * A pointer event the pane reads as a primary press.
 * @param type - The event type.
 * @param x - Client x.
 * @param y - Client y.
 * @returns The event.
 */
function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperty(event, 'isPrimary', { value: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

/**
 * Drags a marquee over the whole board. Each step is its own act so the pane
 * re-renders between them, as it does between real pointer events.
 */
function marqueeAll(): void {
  const pane = document.querySelector('.react-flow__pane');
  if (!pane) throw new Error('the pane is not mounted');
  act(() => {
    pane.dispatchEvent(pointer('pointerdown', 1, 1));
  });
  act(() => {
    pane.dispatchEvent(pointer('pointermove', 50, 50));
  });
  act(() => {
    pane.dispatchEvent(pointer('pointermove', 5000, 5000));
  });
  act(() => {
    pane.dispatchEvent(pointer('pointerup', 5000, 5000));
  });
}

/**
 * Narrows the marquee's selection to these nodes, the way shift-clicks would.
 * @param ids - The nodes to keep selected.
 */
function keepSelected(ids: readonly string[]): void {
  act(() => {
    canvasGraphs.of('s').getState().setFlowNodes((prev) => prev.map((n) => ({ ...n, selected: ids.includes(n.id) })));
  });
}

/** Right-clicks the selection's box, which opens the selection menu. */
function rightClickSelection(): void {
  const rect = document.querySelector('.react-flow__nodesselection-rect');
  if (!rect) throw new Error('no multi-selection box on the canvas');
  fireEvent.contextMenu(rect);
}

beforeEach(async () => {
  vi.mocked(apiGet).mockImplementation((path: string) =>
    path === '/canvas/limits'
      ? Promise.resolve({ referencePoolCap: 10, joinMaxClips: 20 } as unknown as CanvasLimits)
      : Promise.reject(new Error(`unexpected GET ${path}`)),
  );
  canvasApi.resetLimitsCache();
  await canvasApi.fetchLimits();
  canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null, miniTool: null });
  useUIStore.setState({ activeRegion: 'space' });
  useCurrentUserStore.getState().setUser({
    id: 'u-1',
    name: 'Ada',
    email: 'ada@example.com',
    personalStudio: null,
    membershipTier: 'base',
  });
});

describe('Join in the selection menu (inner#1825 §6.5)', () => {
  it('offers Join right above Copy for two video clips that hold content', () => {
    mount([clip('a', 'video', { x: 0, y: 0 }), clip('b', 'video', { x: 400, y: 0 })]);
    marqueeAll();
    rightClickSelection();

    const join = screen.getByTestId('selection-menu-join');
    const copy = screen.getByTestId('selection-menu-copy');
    expect(join.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const items = [...document.querySelectorAll('[data-testid^="selection-menu-"]')].map((el) => el.getAttribute('data-testid'));
    expect(items.indexOf('selection-menu-copy') - items.indexOf('selection-menu-join')).toBe(1);
  });

  it('opens the video join panel on the first clip with every clip prefilled', () => {
    mount([clip('a', 'video', { x: 0, y: 0 }), clip('b', 'video', { x: 400, y: 0 })]);
    marqueeAll();
    rightClickSelection();
    fireEvent.click(screen.getByTestId('selection-menu-join'));

    const session = canvasSessions.of('s').getState();
    expect(session.panelKind).toBe('miniTool');
    expect(session.panelHostId).toBe('a');
    expect(session.miniTool?.toolId).toBe('video.join');
    expect(session.miniTool?.slots.clips).toEqual([
      { url: 'https://cdn/a.mp4', cover: 'https://cdn/a.jpg', duration: 4, nodeId: 'a', name: 'A' },
      { url: 'https://cdn/b.mp4', cover: 'https://cdn/b.jpg', duration: 4, nodeId: 'b', name: 'B' },
    ]);
  });

  it('opens the audio join tool for audio clips', () => {
    mount([clip('a', 'audio', { x: 0, y: 0 }), clip('b', 'audio', { x: 400, y: 0 }), clip('c', 'audio', { x: 800, y: 0 })]);
    marqueeAll();
    rightClickSelection();
    fireEvent.click(screen.getByTestId('selection-menu-join'));
    const draft = canvasSessions.of('s').getState().miniTool;
    expect(draft?.toolId).toBe('audio.join');
    expect((draft?.slots.clips as readonly { nodeId?: string }[] | undefined)?.map((value) => value.nodeId)).toEqual(['a', 'b', 'c']);
  });

  it('orders the clips by where they sit on the canvas, a grouped clip at its group origin plus its own position', () => {
    // `b` is stored at x 20 inside a group at x 500, so it sits at x 520:
    // after `a` and `d` (x 300), before `c` (x 700). `d` shares `a`'s column
    // and sits below it.
    mount([
      clip('c', 'video', { x: 700, y: 0 }),
      { id: 'g', type: 'group', position: { x: 500, y: 0 }, width: 400, height: 400, data: {} } as Nodes[number],
      { ...clip('b', 'video', { x: 20, y: 40 }), parentId: 'g' } as Nodes[number],
      clip('d', 'video', { x: 300, y: 500 }),
      clip('a', 'video', { x: 300, y: 0 }),
    ]);
    marqueeAll();
    keepSelected(['a', 'b', 'c', 'd']);
    rightClickSelection();
    fireEvent.click(screen.getByTestId('selection-menu-join'));

    const session = canvasSessions.of('s').getState();
    const clips = session.miniTool?.slots.clips as readonly { nodeId?: string }[] | undefined;
    expect(clips?.map((value) => value.nodeId)).toEqual(['a', 'd', 'b', 'c']);
    expect(session.panelHostId).toBe('a');
  });

  it.each([
    ['a video and an audio clip', [clip('v1', 'video', { x: 0, y: 0 }), clip('au', 'audio', { x: 400, y: 0 }), clip('v2', 'video', { x: 800, y: 0 })], ['v1', 'au'], ['v1', 'v2']],
    ['a clip that holds nothing', [clip('v1', 'video', { x: 0, y: 0 }), clip('empty', 'video', { x: 400, y: 0 }, { content: undefined, coverUrl: undefined }), clip('v2', 'video', { x: 800, y: 0 })], ['v1', 'empty'], ['v1', 'v2']],
  ] as const)('offers no Join for a selection with %s, and does once the selection is two full clips', (_what, nodes, offending, fine) => {
    mount([...nodes]);
    marqueeAll();
    keepSelected(offending);
    rightClickSelection();
    expect(screen.getByTestId('selection-menu-copy')).toBeInTheDocument();
    expect(screen.queryByTestId('selection-menu-join')).toBeNull();

    keepSelected(fine);
    rightClickSelection();
    expect(screen.getByTestId('selection-menu-join')).toBeInTheDocument();
  });

  it('offers no Join to a Viewer', () => {
    mount([clip('a', 'video', { x: 0, y: 0 }), clip('b', 'video', { x: 400, y: 0 })], true);
    keepSelected(['a', 'b']);
    const rect = document.querySelector('.react-flow__nodesselection-rect');
    if (rect) fireEvent.contextMenu(rect);
    expect(screen.queryByTestId('selection-menu-join')).toBeNull();
  });

  // §6.5 (decided): group nodes in a selection are ignored when deciding
  // whether to offer Join; the rest must be one medium, all holding content.
  it('offers Join for a marquee over a group holding two video clips, the group itself selected too', () => {
    mount([
      { id: 'g', type: 'group', position: { x: 0, y: 0 }, width: 900, height: 400, data: {} } as Nodes[number],
      { ...clip('a', 'video', { x: 20, y: 40 }), parentId: 'g' } as Nodes[number],
      { ...clip('b', 'video', { x: 420, y: 40 }), parentId: 'g' } as Nodes[number],
    ]);
    marqueeAll();
    expect([...document.querySelectorAll('.react-flow__node.selected')].map((n) => n.getAttribute('data-id')).sort()).toEqual(['a', 'b', 'g']);
    rightClickSelection();
    fireEvent.click(screen.getByTestId('selection-menu-join'));
    const clips = canvasSessions.of('s').getState().miniTool?.slots.clips as readonly { nodeId?: string }[] | undefined;
    expect(clips?.map((value) => value.nodeId)).toEqual(['a', 'b']);
  });

  it('offers no Join when a text node is selected beside the clips, and does once only the clips are', () => {
    mount([
      clip('a', 'video', { x: 0, y: 0 }),
      clip('b', 'video', { x: 400, y: 0 }),
      { id: 't', type: 'text', position: { x: 800, y: 0 }, data: { handling: false, name: 'T' } } as Nodes[number],
    ]);
    marqueeAll();
    rightClickSelection();
    expect(screen.getByTestId('selection-menu-copy')).toBeInTheDocument();
    expect(screen.queryByTestId('selection-menu-join')).toBeNull();

    keepSelected(['a', 'b']);
    rightClickSelection();
    expect(screen.getByTestId('selection-menu-join')).toBeInTheDocument();
  });
});

describe('Join from a single node’s Tools submenu (inner#1825 §6.5)', () => {
  it('opens a draft of exactly that clip, named after the node, with Run held and the add tile shown', async () => {
    mount([clip('a', 'video', { x: 0, y: 0 }), clip('b', 'video', { x: 400, y: 0 })]);
    const node = document.querySelector('.react-flow__node[data-id="a"]');
    if (node === null) throw new Error('the clip is not rendered');
    fireEvent.contextMenu(node);
    fireEvent.keyDown(screen.getByTestId('node-menu-tools'), { key: 'ArrowRight' });
    fireEvent.click(await screen.findByTestId('node-menu-tool-video.join'));

    const session = canvasSessions.of('s').getState();
    expect(session.panelHostId).toBe('a');
    expect(session.miniTool?.toolId).toBe('video.join');
    expect(session.miniTool?.slots.clips).toEqual([
      { url: 'https://cdn/a.mp4', cover: 'https://cdn/a.jpg', duration: 4, nodeId: 'a', name: 'A' },
    ]);
    expect(await screen.findByTestId('join-tile-a')).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    expect(screen.getByTestId('join-add')).toBeInTheDocument();
  });
});
