// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web test spec E-11): a drag release, a
 * join and a Group resize write in one `runCanvasUndoBatch` of kind `edit`.
 * Full or over the ceiling, the write is refused and the render buffer goes
 * back to what Yjs holds (lint/smoke spec answer Q-10), since an unchanged
 * document never re-syncs it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';

// The real ReactFlow, with the props the canvas hands it kept so the test can
// report a drag the way xyflow does; jsdom cannot run d3-drag.
const flow = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  resizer: null as null | {
    onResizeStart: () => void;
    onResizeEnd: (event: unknown, params: { x: number; y: number; width: number; height: number }) => void;
  },
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown>) => {
      flow.props = props;
      return createElement(actual.ReactFlow as unknown as React.ComponentType<Record<string, unknown>>, props);
    },
  };
});
// The resize controls, kept as their handlers: ReactFlow's NodeResizeControl
// needs pointer geometry jsdom does not have.
vi.mock('@web/spaces/canvas/nodes/GroupResizer', () => ({
  GroupResizer: (props: NonNullable<typeof flow.resizer>): null => {
    flow.resizer = props;
    return null;
  },
}));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
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
  const actual = await importOriginal<typeof import('@web/data/yjs/space-connection')>();
  const { useSocket } = await import('@web/data/yjs/use-socket');
  return { ...actual, useSpaceConnection: () => useSocket({ name: '', doc: undefined as never }) };
});
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { CANVAS_NODES_KEY, type CanvasNodeFields } from '@breatic/shared';
import type { Node, NodeChange, OnNodeDrag } from '@xyflow/react';
import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, createGroup, readNodes, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { createGroupNode } from '@web/spaces/canvas/node-factory';
import { GROUP_PADDING } from '@web/spaces/canvas/group-geometry';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useCanvasStore, useUIStore } from '@web/stores';
import { canvasGraphs } from '@web/stores/canvas-graph';
import { SIZE_COPY_EN, enterSize, type SizeCode } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p';
const SID = 's';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Seeds an image node.
 * @param id - Node id.
 * @param x - Its x.
 * @param y - Its y.
 */
function seedImage(id: string, x: number, y: number): void {
  addNode(PID, SID, {
    id,
    type: 'image',
    position: { x, y },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [], content: `https://cdn.example.test/${id}.png` },
  } as CanvasNodeFields);
}

/**
 * Seeds Group g1 at (100, 100), 400 x 300, holding image m1.
 */
function seedGroup(): void {
  seedImage('m1', 0, 0);
  createGroup(PID, SID, createGroupNode('g1', { x: 100, y: 100 }, 400, 300, 'u1'), [
    { id: 'm1', position: { x: GROUP_PADDING, y: GROUP_PADDING } },
  ]);
}

/**
 * Enters one size state and mounts the real canvas on what the document holds.
 * @param code - The size state.
 * @param seed - Writes the board, before any push.
 * @returns The canvas document.
 * @throws {Error} When mounting fails.
 */
function mountAt(code: SizeCode, seed: () => void): Y.Doc {
  const doc = getDoc(NAME);
  seed();
  enterSize(NAME, code);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
    </QueryClientProvider>,
  );
  return doc;
}

/**
 * The render buffer's copy of a node.
 * @param id - Node id.
 * @returns The buffered node.
 * @throws {Error} When the buffer does not hold it.
 */
function buffered(id: string): Node {
  const node = canvasGraphs.of(SID).getState().flowNodes.find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} is not in the render buffer`);
  return node;
}

/**
 * What the document stores for a node.
 * @param doc - Canvas document.
 * @param id - Node id.
 * @returns Position, parent and size.
 */
function stored(doc: Y.Doc, id: string): { position: unknown; parentId: unknown; width: unknown; height: unknown } {
  const node = doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get(id)!;
  const data = node.get('data') as Y.Map<unknown>;
  return { position: node.get('position'), parentId: node.get('parentId'), width: data.get('width'), height: data.get('height') };
}

/**
 * Drags a node to a flow position and lets go, reporting each step the way
 * xyflow does: start, position changes while dragging, the final change, stop.
 * @param id - The dragged node.
 * @param to - Where it is let go.
 */
function dragTo(id: string, to: { x: number; y: number }): void {
  const props = flow.props!;
  const onNodesChange = props.onNodesChange as (changes: NodeChange[]) => void;
  const start = buffered(id);
  act(() => {
    (props.onNodeDragStart as OnNodeDrag)(new MouseEvent('mousedown'), start, [start]);
  });
  act(() => {
    onNodesChange([{ type: 'position', id, position: to, dragging: true }]);
    (props.onNodeDrag as OnNodeDrag)(new MouseEvent('mousemove'), buffered(id), [buffered(id)]);
  });
  act(() => {
    onNodesChange([{ type: 'position', id, position: to, dragging: false }]);
    const moved = buffered(id);
    (props.onNodeDragStop as OnNodeDrag)(new MouseEvent('mouseup'), moved, [moved]);
  });
}

/**
 * Resizes Group g1 through its resize controls and lets go.
 * @param rect - The rect ReactFlow reports at release.
 * @throws {Error} When the controls are not shown.
 */
function resizeGroupTo(rect: { x: number; y: number; width: number; height: number }): void {
  if (!flow.resizer) throw new Error('the Group resize controls are not shown');
  const onNodesChange = flow.props!.onNodesChange as (changes: NodeChange[]) => void;
  act(() => {
    flow.resizer!.onResizeStart();
  });
  act(() => {
    onNodesChange([
      { type: 'position', id: 'g1', position: { x: rect.x, y: rect.y } },
      { type: 'dimensions', id: 'g1', dimensions: { width: rect.width, height: rect.height }, resizing: true, setAttributes: true },
    ]);
  });
  act(() => {
    flow.resizer!.onResizeEnd(new MouseEvent('mouseup'), rect);
  });
}

/**
 * Selects Group g1 so its resize controls show.
 */
function selectGroup(): void {
  act(() => {
    canvasGraphs.of(SID).getState().setFlowNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === 'g1' })));
  });
}

beforeEach(() => {
  flow.props = null;
  flow.resizer = null;
  useUIStore.setState({ activeRegion: 'space' });
  useCanvasStore.setState({ snapToGrid: false });
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const REFUSED = [
  ['F', SIZE_COPY_EN.T_ADD],
  ['O', SIZE_COPY_EN.T_OVER],
] as const;

describe('E-11 a drag release is an edit batch', () => {
  it('E-11 lands the node where it was let go in the warning band [W]', () => {
    const doc = mountAt('W', () => seedImage('t1', 100, 100));
    dragTo('t1', { x: 400, y: 300 });
    expect(stored(doc, 't1').position).toEqual({ x: 400, y: 300 });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each(REFUSED)('E-11 refuses the move and puts the node back where Yjs has it [%s]', (code, sentence) => {
    const doc = mountAt(code, () => seedImage('t1', 100, 100));
    const before = Y.encodeStateAsUpdate(doc);
    dragTo('t1', { x: 400, y: 300 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(stored(doc, 't1').position).toEqual({ x: 100, y: 100 });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(sentence);
    expect(toast.error).not.toHaveBeenCalled();
    expect(buffered('t1').position).toEqual({ x: 100, y: 100 });
  });

  it('E-11 refuses the move without a toast while the document is rebuilt, and puts the node back [Z]', () => {
    const doc = mountAt('Z', () => seedImage('t1', 100, 100));
    const before = Y.encodeStateAsUpdate(doc);
    dragTo('t1', { x: 400, y: 300 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(buffered('t1').position).toEqual({ x: 100, y: 100 });
  });
});

describe('E-11 a Group resize and a join are edit batches', () => {
  /** Seeds g1 with member m1 and a loose node t1 to the right of it. */
  const seed = (): void => {
    seedGroup();
    seedImage('t1', 700, 100);
  };

  it.each(REFUSED)('E-11 refuses the resize and puts the Group back [%s]', (code, sentence) => {
    const doc = mountAt(code, seed);
    selectGroup();
    const before = Y.encodeStateAsUpdate(doc);
    resizeGroupTo({ x: 100, y: 100, width: 640, height: 480 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(stored(doc, 'g1')).toMatchObject({ position: { x: 100, y: 100 }, width: 400, height: 300 });
    expect(stored(doc, 'm1').parentId).toBe('g1');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(sentence);
    expect(buffered('g1')).toMatchObject({ position: { x: 100, y: 100 }, width: 400, height: 300 });
  });

  it.each(REFUSED)('E-11 refuses a join and puts the node back with its old parent [%s]', (code, sentence) => {
    const doc = mountAt(code, seed);
    const before = Y.encodeStateAsUpdate(doc);
    dragTo('t1', { x: 250, y: 200 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(stored(doc, 't1')).toMatchObject({ position: { x: 700, y: 100 }, parentId: undefined });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(sentence);
    expect(buffered('t1').position).toEqual({ x: 700, y: 100 });
    expect(buffered('t1').parentId).toBeUndefined();
  });

  it('E-11 resizes and joins in the warning band [W]', () => {
    const doc = mountAt('W', seed);
    selectGroup();
    resizeGroupTo({ x: 100, y: 100, width: 640, height: 480 });
    expect(stored(doc, 'g1')).toMatchObject({ width: 640, height: 480 });
    dragTo('t1', { x: 250, y: 200 });
    expect(stored(doc, 't1').parentId).toBe('g1');
    expect(readNodes(doc).find((n) => n.id === 't1')?.parentId).toBe('g1');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
