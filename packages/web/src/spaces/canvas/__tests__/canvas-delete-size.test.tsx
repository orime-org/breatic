// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web test spec B-04 to B-10): a delete on
 * the mounted canvas is judged before ReactFlow drops anything locally.
 * `onBeforeDelete` gives the deletion the kind `removeElements` would
 * (`compound` when a Group loses its frame but keeps a member outside the
 * deletion, otherwise `remove`) and answers false with the state's toast when
 * it is not allowed. The deleted-asset report follows only a write that ran.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';

// The real ReactFlow, with the props the canvas hands it kept so a case can
// delete the way xyflow does: `onBeforeDelete`, then `onDelete` with what it let through.
const flow = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
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
import type { Edge, Node } from '@xyflow/react';
import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, startDocResync } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, createGroup, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { createGroupNode } from '@web/spaces/canvas/node-factory';
import { GROUP_PADDING } from '@web/spaces/canvas/group-geometry';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useUIStore } from '@web/stores';
import { canvasGraphs } from '@web/stores/canvas-graph';
import {
  SIZE_COPY_EN,
  SIZE_COPY_ZH_CN,
  captureWrite,
  enterSize,
  expectKindShape,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p';
const SID = 's';
const NAME = docName.canvasSpace(PID, SID);
const PICTURE = 'https://cdn.example.test/img1.png';

type BeforeDelete = (args: { nodes: Node[]; edges: Edge[] }) => Promise<boolean | { nodes: Node[]; edges: Edge[] }>;
type OnDelete = (args: { nodes: Node[]; edges: Edge[] }) => void;

/**
 * Seeds an image node.
 * @param id - Node id.
 * @param x - Its x.
 */
function seedImage(id: string, x: number): void {
  addNode(PID, SID, {
    id,
    type: 'image',
    position: { x, y: 0 },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [], content: `https://cdn.example.test/${id}.png` },
  } as CanvasNodeFields);
}

/**
 * The board, written while the size is unknown: image `img1` and Group `g3`
 * holding `m3`.
 */
function seed(): void {
  seedImage('img1', 1200);
  seedImage('m3', 0);
  createGroup(PID, SID, createGroupNode('g3', { x: 100, y: 600 }, 400, 300, 'u1'), [
    { id: 'm3', position: { x: GROUP_PADDING, y: GROUP_PADDING } },
  ]);
}

/**
 * Seeds the board, enters one size state and mounts the real canvas.
 * @param code - The size state.
 * @returns The canvas document.
 * @throws {Error} When mounting fails.
 */
function mountAt(code: SizeCode): Y.Doc {
  const doc = getDoc(NAME);
  seed();
  enterSize(NAME, code);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
    </QueryClientProvider>,
  );
  vi.mocked(toast.warning).mockClear();
  return doc;
}

/**
 * The render buffer's copies of some nodes.
 * @param ids - Node ids.
 * @returns The buffered nodes.
 * @throws {Error} When the buffer does not hold one.
 */
function buffered(...ids: string[]): Node[] {
  const all = canvasGraphs.of(SID).getState().flowNodes;
  return ids.map((id) => {
    const node = all.find((n) => n.id === id);
    if (!node) throw new Error(`node ${id} is not in the render buffer`);
    return node;
  });
}

/**
 * Asks the canvas's `onBeforeDelete`, as xyflow does on Delete.
 * @param ids - The nodes being deleted.
 * @returns Its answer.
 */
async function beforeDelete(...ids: string[]): Promise<boolean | { nodes: Node[]; edges: Edge[] }> {
  const ask = flow.props!.onBeforeDelete as BeforeDelete;
  let answer: boolean | { nodes: Node[]; edges: Edge[] } = true;
  await act(async () => {
    answer = await ask({ nodes: buffered(...ids), edges: [] });
  });
  return answer;
}

/**
 * The size sentences among the warnings shown (a lock toast may show too).
 * @returns The size sentences, in order.
 */
function sizeToasts(): unknown[] {
  const sentences = new Set<unknown>([...Object.values(SIZE_COPY_EN), ...Object.values(SIZE_COPY_ZH_CN)]);
  return vi.mocked(toast.warning).mock.calls.map(([message]) => message).filter((m) => sentences.has(m));
}

/**
 * The ids the render buffer holds.
 * @returns The ids, sorted.
 */
function bufferIds(): string[] {
  return canvasGraphs.of(SID).getState().flowNodes.map((n) => n.id).sort();
}

/**
 * Deletes a node through its node menu (`commitGuardedDelete`).
 * @param id - The node.
 * @throws {Error} When the node is not rendered.
 */
function deleteFromMenu(id: string): void {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`node ${id} is not rendered`);
  fireEvent.contextMenu(el);
  fireEvent.click(screen.getByTestId('node-menu-delete'));
}

let reported: MockInstance<typeof assetsApi.reportDeleted>;

beforeEach(() => {
  flow.props = null;
  useUIStore.setState({ activeRegion: 'space' });
  reported = vi.spyOn(assetsApi, 'reportDeleted').mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof assetsApi.reportDeleted>>);
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

describe('B-04 to B-07 ReactFlow deletion is judged in onBeforeDelete', () => {
  // A locked member protects its Group too (`filterGatedDeletion`), so the
  // frame-without-member deletion is built by handing xyflow the frame alone.
  it('B-04 refuses a Group frame whose member stays outside, keeping every local node [F]', async () => {
    const doc = mountAt('F');
    const before = Y.encodeStateAsUpdate(doc);
    expect(await beforeDelete('g3')).toBe(false);
    expect(sizeToasts()).toEqual([SIZE_COPY_EN.T_COMPOUND]);
    expect(bufferIds()).toEqual(expect.arrayContaining(['g3', 'm3']));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('B-05 lets a whole node through over the ceiling and onDelete removes it as a remove [O]', async () => {
    const doc = mountAt('O');
    const answer = await beforeDelete('img1');
    expect(answer).not.toBe(false);
    if (typeof answer === 'boolean') throw new Error('onBeforeDelete answered a boolean');
    expect(answer.nodes.map((n) => n.id)).toEqual(['img1']);
    const onDelete = flow.props!.onDelete as OnDelete;
    const captured = captureWrite(doc, () => act(() => onDelete(answer)));
    expectKindShape('remove', captured);
    expect(doc.getMap(CANVAS_NODES_KEY).has('img1')).toBe(false);
    expect(sizeToasts()).toEqual([]);
  });

  it('B-06 refuses a Group frame with a member outside over the ceiling, with the whole-node sentence [O]', async () => {
    const doc = mountAt('O');
    const before = Y.encodeStateAsUpdate(doc);
    expect(await beforeDelete('g3')).toBe(false);
    expect(sizeToasts()).toEqual([SIZE_COPY_EN.T_OVER]);
    expect(bufferIds()).toEqual(expect.arrayContaining(['g3', 'm3']));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('B-07 refuses any deletion while the document is rebuilt, without a toast [Z]', async () => {
    const doc = mountAt('Z');
    const before = Y.encodeStateAsUpdate(doc);
    expect(await beforeDelete('img1')).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(bufferIds()).toContain('img1');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('B-08 to B-10 deleted assets are reported only after a write that ran', () => {
  // The menu deletes a Group with all its members (`groupDeletionIds`), and a
  // protected member protects the Group, so a refused menu delete is reached
  // through the rebuild only.
  it('B-08 a menu delete while the document is rebuilt reports nothing [Z]', () => {
    const doc = mountAt('Z');
    const before = Y.encodeStateAsUpdate(doc);
    deleteFromMenu('img1');
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(reported).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('B-09 a menu delete of a whole node at full removes it and reports its picture once [F]', () => {
    const doc = mountAt('F');
    deleteFromMenu('img1');
    expect(doc.getMap(CANVAS_NODES_KEY).has('img1')).toBe(false);
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0][0].entries.map((entry) => entry.fileUrl)).toContain(PICTURE);
    expect(sizeToasts()).toEqual([]);
  });

  it('B-10 onDelete reports nothing when the write it makes is refused after onBeforeDelete let it through', async () => {
    const doc = mountAt('F');
    const answer = await beforeDelete('img1');
    if (typeof answer === 'boolean') throw new Error('onBeforeDelete did not let the node through');
    // The document is refused and rebuilt between the two callbacks.
    startDocResync(NAME);
    const before = Y.encodeStateAsUpdate(doc);
    act(() => (flow.props!.onDelete as OnDelete)(answer));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(reported).not.toHaveBeenCalled();
  });
});
