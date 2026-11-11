// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web test spec, E-01 and E-04): picking a
 * type in the connect-create menu builds the node and its wire in one
 * `runCanvasUndoBatch` of kind `add`, refused at full and over the ceiling,
 * silently while the document is rebuilt.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';

// The real ReactFlow, with the props the canvas hands it kept so the test can
// end a connection drag the way xyflow reports one; jsdom has no hit testing
// for a real handle drag.
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
import type { OnConnectEnd } from '@xyflow/react';
import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, readEdges, readNodes, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useUIStore } from '@web/stores';
import { canvasGraphs } from '@web/stores/canvas-graph';
import { SIZE_COPY_EN, enterSize, type SizeCode } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p';
const SID = 's';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Seeds an image source node, enters one size state and mounts the real canvas.
 * @param code - The size state.
 * @returns The canvas document.
 * @throws {Error} When mounting fails.
 */
function mountAt(code: SizeCode): Y.Doc {
  const doc = getDoc(NAME);
  addNode(PID, SID, {
    id: 'i1',
    type: 'image',
    position: { x: 0, y: 0 },
    data: { name: 'i1', createdAt: 1, createdBy: 'u1', locked: false, attachments: [], content: 'https://cdn.example.test/i1.png' },
  } as CanvasNodeFields);
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
 * Ends a drag from i1's output handle over blank canvas, which opens the
 * connect-create menu at the release point.
 * @throws {Error} When the canvas has not mounted.
 */
function releaseOnBlankCanvas(): void {
  const pane = document.querySelector('.react-flow__pane');
  if (!pane || !flow.props) throw new Error('the canvas is not mounted');
  vi.spyOn(document, 'elementsFromPoint').mockReturnValue([pane]);
  const onConnectEnd = flow.props.onConnectEnd as OnConnectEnd;
  act(() => {
    onConnectEnd(new MouseEvent('mouseup', { clientX: 200, clientY: 200 }), {
      fromNode: { id: 'i1', type: 'image' },
      fromHandle: { type: 'source' },
      toNode: null,
      isValid: null,
    } as unknown as Parameters<OnConnectEnd>[1]);
  });
}

beforeEach(() => {
  flow.props = null;
  useUIStore.setState({ activeRegion: 'space' });
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

describe('E-01 connect-create is one add batch', () => {
  it.each([
    ['F', SIZE_COPY_EN.T_ADD],
    ['O', SIZE_COPY_EN.T_OVER],
  ] as const)('E-01 creates no node and no wire and warns once [%s]', async (code, sentence) => {
    const doc = mountAt(code);
    const before = Y.encodeStateAsUpdate(doc);
    releaseOnBlankCanvas();
    await userEvent.setup().click(await screen.findByTestId('create-node-text'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(sentence);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBe(1);
    expect(readEdges(doc)).toHaveLength(0);
    expect(toast.error).not.toHaveBeenCalled();
    expect(canvasGraphs.of(SID).getState().flowNodes.filter((n) => n.selected === true)).toEqual([]);
  });

  it('E-01 creates nothing and says nothing while the document is rebuilt [Z]', async () => {
    const doc = mountAt('Z');
    const before = Y.encodeStateAsUpdate(doc);
    releaseOnBlankCanvas();
    await userEvent.setup().click(await screen.findByTestId('create-node-text'));
    await act(async () => { await Promise.resolve(); });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readEdges(doc)).toHaveLength(0);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('E-01 creates the node and the wire from the source in the warning band [W]', async () => {
    const doc = mountAt('W');
    releaseOnBlankCanvas();
    await userEvent.setup().click(await screen.findByTestId('create-node-text'));
    await waitFor(() => expect(readNodes(doc)).toHaveLength(2));
    const created = readNodes(doc).find((n) => n.id !== 'i1')!;
    expect(created.type).toBe('text');
    expect(readEdges(doc).map((e) => [e.id, e.source, e.target])).toEqual([[`i1->${created.id}`, 'i1', created.id]]);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
