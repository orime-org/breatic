// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

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

/**
 * Runs a press and collects what its handlers threw: a pick that went on
 * after a refused build (no node) throws inside the menu's handler, which the
 * page reports as an uncaught error rather than failing the test.
 * @param run - The press.
 * @returns The errors thrown meanwhile.
 * @throws {Error} Whatever `run` itself throws.
 */
async function uncaughtDuring(run: () => Promise<void>): Promise<unknown[]> {
  const thrown: unknown[] = [];
  const onError = (event: ErrorEvent): void => {
    thrown.push(event.error);
  };
  window.addEventListener('error', onError);
  try {
    await run();
  } finally {
    window.removeEventListener('error', onError);
  }
  return thrown;
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
    const thrown = await uncaughtDuring(async () => {
      await userEvent.setup().click(await screen.findByTestId('create-node-text'));
      await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    });
    expect(thrown).toEqual([]);
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

// inner#2216: the selection plus builds through the same one-add batch. A
// refused build leaves nothing behind: no node, no wire, the selection the
// user made untouched and the camera where it was. In jsdom xyflow reads the
// pane as 0 and falls back to 500 x 500 (`useResizeHandler`), and nodes are
// unmeasured (0 x 0), so with i2 at x 1200 the new node lands one column
// right of it, outside the view at the opening camera: a build slides the
// camera there (`viewportForBuilt`), a refusal must not.
describe('the selection plus is one add batch', () => {
  /**
   * Seeds two image nodes, enters one size state, mounts the real canvas and
   * selects both, which puts the selection plus beside them.
   * @param code - The size state.
   * @returns The canvas document.
   * @throws {Error} When mounting fails.
   */
  async function mountTwoSelectedAt(code: SizeCode): Promise<Y.Doc> {
    addNode(PID, SID, {
      id: 'i2',
      type: 'image',
      position: { x: 1200, y: 400 },
      data: { name: 'i2', createdAt: 1, createdBy: 'u1', locked: false, attachments: [], content: 'https://cdn.example.test/i2.png' },
    } as CanvasNodeFields);
    const doc = mountAt(code);
    await waitFor(() => expect(canvasGraphs.of(SID).getState().flowNodes).toHaveLength(2));
    act(() => {
      canvasGraphs.of(SID).getState().setFlowNodes((prev) => prev.map((n) => ({ ...n, selected: true })));
    });
    return doc;
  }

  const selectedIds = (): string[] =>
    canvasGraphs.of(SID).getState().flowNodes.filter((n) => n.selected === true).map((n) => n.id).sort();

  const camera = (): string =>
    (document.querySelector('.react-flow__viewport') as HTMLElement | null)?.style.transform ?? 'no viewport';

  it.each(['F', 'O'] as const)('creates nothing, keeps the selection and leaves the camera [%s]', async (code) => {
    const doc = await mountTwoSelectedAt(code);
    await waitFor(() => expect(selectedIds()).toEqual(['i1', 'i2']));
    const before = Y.encodeStateAsUpdate(doc);
    const opening = camera();
    const thrown = await uncaughtDuring(async () => {
      const user = userEvent.setup();
      await user.click(await screen.findByTestId('selection-add-button'));
      await user.click(await screen.findByTestId('create-node-text'));
      await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); });
    });
    expect(thrown).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readNodes(doc).map((n) => n.id).sort()).toEqual(['i1', 'i2']);
    expect(readEdges(doc)).toHaveLength(0);
    expect(selectedIds()).toEqual(['i1', 'i2']);
    // Longer than the slide the control case below observes.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(camera()).toBe(opening);
  });

  // Control: the same press in the warning band builds the node, selects it
  // alone and slides the camera to it, so the kept selection and camera above
  // are not vacuous.
  it('builds the node wired from both, selects it and slides the camera to it in the warning band [W]', async () => {
    const doc = await mountTwoSelectedAt('W');
    await waitFor(() => expect(selectedIds()).toEqual(['i1', 'i2']));
    const opening = camera();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('selection-add-button'));
    await user.click(await screen.findByTestId('create-node-text'));
    await waitFor(() => expect(readNodes(doc)).toHaveLength(3));
    const created = readNodes(doc).find((n) => n.id !== 'i1' && n.id !== 'i2')!;
    expect(readEdges(doc).map((e) => e.target)).toEqual([created.id, created.id]);
    await waitFor(() => expect(selectedIds()).toEqual([created.id]));
    await waitFor(() => expect(camera()).not.toBe(opening));
  });
});
