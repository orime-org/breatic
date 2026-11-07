// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web test spec RQ-17, RQ-18, RQ-19, RQ-22):
 * the canvas entries whose request makes the server write into a node that
 * already exists. `canAdd` is asked before the request; when it is false the
 * request is not sent and the state's toast shows (`full` the add sentence,
 * over the ceiling the whole-node sentence, a rebuild nothing; spec answer
 * Q4). A browser mini-tool's export fails each result node's upload mark
 * instead. Results of tasks sent before the Space filled land as usual, and
 * the entries that only touch task counts are not judged at all.
 *
 * The canvas is mounted on the real document (the binding hook stays real;
 * the socket is stood in for), as `drop-text-file-size-gate.test.tsx` mounts it.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';

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
vi.mock('@web/data/upload/hash', () => ({ hashFile: vi.fn(() => Promise.resolve('a'.repeat(64))) }));
vi.mock('@web/data/upload/finish-upload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/upload/finish-upload')>();
  return { ...actual, sendFileAndFinish: vi.fn(actual.sendFileAndFinish) };
});
// The task list renders as itself; its Retry callback is kept so a case can
// press Retry on a failed upload row the way the list does.
const taskPanel = vi.hoisted(() => ({ onRetry: null as null | ((nodeId: string, taskId: string) => Promise<void> | undefined) }));
vi.mock('@web/spaces/canvas/tasks/NodeTaskPanelContainer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/tasks/NodeTaskPanelContainer')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    NodeTaskPanelContainer: (props: React.ComponentProps<typeof actual.NodeTaskPanelContainer>) => {
      taskPanel.onRetry = props.onRetry;
      return createElement(actual.NodeTaskPanelContainer, props);
    },
  };
});

import { CANVAS_NODES_KEY, setLocale, t, type CanvasNodeFields } from '@breatic/shared';
import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api';
import { canvasApi } from '@web/data/api/canvas';
import { BytesNotDelivered, sendFileAndFinish } from '@web/data/upload/finish-upload';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { addNode, readNodes, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { fillNodesFromFiles } from '@web/spaces/canvas/canvas-upload';
import * as blankPng from '@web/spaces/canvas/empty-image/generate-blank-png';
import { NodeTaskPanelContainer } from '@web/spaces/canvas/tasks/NodeTaskPanelContainer';
import { getRetryUpload, resetRetryFilesForTests, stashRetryFile } from '@web/spaces/canvas/upload-retry-files';
import { useUIStore } from '@web/stores';
import { canvasSessions } from '@web/stores/canvas-session';
import { useTaskActionsInFlight } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore, type UploadMarkMessage } from '@web/stores/upload-marks';
import {
  P_FULL,
  SIZE_COPY_EN,
  enterSize,
  pushSize,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p';
const SID = 's';
const NAME = docName.canvasSpace(PID, SID);
const PICTURE = 'https://cdn.example.test/img1.png';

/**
 * Seeds an empty image node `e1` and an image node `img1` holding a picture,
 * while the size is still unknown.
 */
function seed(): void {
  const base = { createdAt: 1, createdBy: 'u1', attachments: [] };
  addNode(PID, SID, { id: 'e1', type: 'image', position: { x: 0, y: 0 }, data: { name: 'e1', ...base } } as CanvasNodeFields);
  addNode(PID, SID, { id: 'img1', type: 'image', position: { x: 600, y: 0 }, data: { name: 'img1', content: PICTURE, ...base } } as CanvasNodeFields);
}

/**
 * Seeds the board, enters one size state and mounts the real canvas on it.
 * @param code - The size state.
 * @returns The canvas document.
 * @throws {Error} When mounting fails.
 */
function mountAt(code: SizeCode): Y.Doc {
  const doc = getDoc(NAME);
  seed();
  enterSize(NAME, code);
  vi.mocked(toast.warning).mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
    </QueryClientProvider>,
  );
  return doc;
}

/**
 * The rendered node element.
 * @param id - Node id.
 * @returns The element.
 * @throws {Error} When the node is not on screen.
 */
function nodeElement(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!el) throw new Error(`node ${id} is not rendered`);
  return el;
}

/**
 * Chooses a file in the canvas's upload picker, if the entry opened it.
 * @param picker - The spy on the picker's click.
 * @param file - The chosen file.
 */
function chooseIfOpened(picker: MockInstance, file: File): void {
  if (picker.mock.calls.length === 0) return;
  const input = screen.getByTestId('canvas-upload-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  act(() => {
    fireEvent.change(input);
  });
}

/**
 * Lets the upload flow's awaits (config, hash) run.
 * @returns Resolves after a few rounds of microtasks.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** The four `fillUpload` entries (design 5.2 "server writes into an existing node"). */
const ENTRIES: ReadonlyArray<readonly [string, (picker: MockInstance, file: File) => void]> = [
  ['a double-click on an empty node', (picker, file) => {
    act(() => {
      nodeElement('e1').querySelector('[data-testid="node-placeholder"]')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
    chooseIfOpened(picker, file);
  }],
  ['the node menu Upload', (picker, file) => {
    fireEvent.contextMenu(nodeElement('img1'));
    fireEvent.click(screen.getByTestId('node-menu-upload'));
    chooseIfOpened(picker, file);
  }],
  ['Retry on a failed upload row', () => {
    if (!taskPanel.onRetry) throw new Error('the task list is not mounted');
    // Not awaited: an allowed re-send waits on a ticket that never answers.
    act(() => {
      void taskPanel.onRetry!('img1', 'task-1');
    });
  }],
  ['reset to a blank image', () => {
    act(() => {
      canvasSessions.of(SID).getState().openEmptyImagePanel('img1');
    });
    fireEvent.click(screen.getByTestId('empty-image-execute'));
  }],
];

/**
 * How a mark message reads on screen.
 * @param message - The mark's message.
 * @returns The sentence.
 */
function rendered(message: UploadMarkMessage): string {
  return 'text' in message ? message.text : t(message.key, message.params);
}

let ticket: MockInstance<typeof assetsApi.requestUploadTicket>;
let picker: MockInstance;
const FILE = new File(['x'], 'next.png', { type: 'image/png' });

beforeEach(() => {
  setLocale('en');
  taskPanel.onRetry = null;
  resetRetryFilesForTests();
  stashRetryFile(PID, SID, 'task-1', FILE);
  useUIStore.setState({ activeRegion: 'space' });
  useUploadMarksStore.setState({ marks: {} });
  useTaskActionsInFlight.setState({ inFlight: new Set() });
  canvasSessions.of(SID).setState({ panelHostId: null, panelKind: null, pickSession: null });
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({
    maxUploadBytes: 2147483648,
    clientMaxAttempts: 1,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 60000,
    uploadStatusPollSeconds: 2,
    assetUrlPrefix: 'https://cdn/',
  });
  ticket = vi.spyOn(assetsApi, 'requestUploadTicket').mockReturnValue(new Promise(() => {}));
  picker = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
  vi.spyOn(blankPng, 'generateBlankPng').mockResolvedValue(new File(['x'], 'blank.png', { type: 'image/png' }));
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  resetRetryFilesForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('RQ-17 fillUpload asks canAdd before the ticket', () => {
  it.each(ENTRIES)('RQ-17 %s sends no ticket and warns once at full [F]', async (_entry, run) => {
    const doc = mountAt('F');
    const before = Y.encodeStateAsUpdate(doc);
    run(picker, FILE);
    await settle();
    expect(ticket).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([SIZE_COPY_EN.T_ADD]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    // A refused Retry keeps the File for the next press.
    expect(getRetryUpload(PID, SID, 'task-1')?.file).toBe(FILE);
  });

  it.each(ENTRIES)('RQ-17 %s sends no ticket and asks for a whole-node delete over the ceiling [O]', async (_entry, run) => {
    mountAt('O');
    run(picker, FILE);
    await settle();
    expect(ticket).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([SIZE_COPY_EN.T_OVER]);
  });

  it.each(ENTRIES)('RQ-17 %s sends no ticket and says nothing while the document is rebuilt [Z]', async (_entry, run) => {
    mountAt('Z');
    run(picker, FILE);
    await settle();
    expect(ticket).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each(ENTRIES)('RQ-17 %s asks for the ticket in the warning band [W]', async (_entry, run) => {
    mountAt('W');
    run(picker, FILE);
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(1));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('RQ-18 a browser mini-tool export into its result nodes', () => {
  /**
   * Opens the two result nodes' marks the way the tool's press does, then
   * hands their exports over.
   * @param code - The size state when the export is ready.
   * @returns The batch ticket spy.
   */
  function exportInto(code: SizeCode): MockInstance {
    getDoc(NAME);
    seed();
    enterSize(NAME, 'W');
    const marks = useUploadMarksStore.getState();
    const entries = ['e1', 'img1'].map((nodeId) => ({
      nodeId,
      file: new File(['x'], `${nodeId}.png`, { type: 'image/png' }),
      markOp: marks.begin(SID, nodeId, 'upload'),
    }));
    // The Space fills up after the result nodes were built.
    if (code === 'F') pushSize(NAME, P_FULL);
    else enterSize(NAME, code);
    vi.mocked(toast.warning).mockClear();
    const batch = vi.fn(() => new Promise<never>(() => {}));
    fillNodesFromFiles(entries, PID, {
      getUploadConfig: assetsApi.fetchUploadConfig,
      hashFile: vi.fn(() => Promise.resolve('a'.repeat(64))),
      requestTicketBatch: batch as unknown as typeof assetsApi.requestUploadTicketBatch,
      sendToIngest: vi.fn(),
      spaceId: SID,
      tag: { source: 'mini_tool', toolName: 'crop' },
      isLocked: () => false,
      onLocked: vi.fn(),
      track: vi.fn(),
      onUploadFailure: vi.fn(),
    });
    return batch;
  }

  it('RQ-18 requests no batch ticket and fails every result node\'s mark with the full reason [F]', async () => {
    const batch = exportInto('F');
    await settle();
    expect(batch).not.toHaveBeenCalled();
    for (const nodeId of ['e1', 'img1']) {
      const mark = useUploadMarksStore.getState().markOf(SID, nodeId);
      if (mark?.state !== 'failed') throw new Error(`${nodeId} has no failed mark: ${JSON.stringify(mark)}`);
      expect(rendered(mark.message)).toBe(SIZE_COPY_EN.T_REASON);
    }
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('RQ-18 requests the batch ticket in the warning band [W]', async () => {
    const batch = exportInto('W');
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));
    expect(useUploadMarksStore.getState().markOf(SID, 'e1')?.state).not.toBe('failed');
  });
});

describe('RQ-19 a task sent before the Space filled lands as usual', () => {
  it('RQ-19 applies the server\'s result write into the node and says nothing', async () => {
    const doc = mountAt('F');
    // Collab writes the finished result into the existing node (task-listener).
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    const data = server.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).get('e1')!.get('data') as Y.Map<unknown>;
    const update: Uint8Array[] = [];
    server.on('update', (u: Uint8Array) => update.push(u));
    server.transact(() => data.set('content', 'https://cdn.example.test/result.png'));
    act(() => {
      Y.applyUpdate(doc, Y.mergeUpdates(update), 'remote');
    });
    await settle();
    expect(readNodes(doc).find((n) => n.id === 'e1')?.data).toMatchObject({ content: 'https://cdn.example.test/result.png' });
    await waitFor(() => expect(nodeElement('e1').querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.test/result.png'));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('RQ-22 entries that only touch task counts are not judged', () => {
  it('RQ-22 opening the task list and clearing a row still ask the server at full [F]', async () => {
    getDoc(NAME);
    enterSize(NAME, 'F');
    const list = vi.spyOn(canvasApi, 'listNodeTasks').mockResolvedValue([
      {
        id: 'task-1',
        status: 'failed',
        action: 'upload',
        label: 'next.png',
        startedByUserId: 'u1',
        startedAt: '2026-11-07T10:00:00.000Z',
        settledAt: '2026-11-07T10:01:00.000Z',
        budgetMs: 7_200_000,
        errorMessage: 'aborted',
        content: null,
      },
    ] as unknown as Awaited<ReturnType<typeof canvasApi.listNodeTasks>>);
    const dismiss = vi.spyOn(canvasApi, 'dismissNodeTask').mockResolvedValue(
      { removed: true, counts: { running: 0, done: 0, failed: 0, expired: 0 } } as unknown as Awaited<ReturnType<typeof canvasApi.dismissNodeTask>>,
    );
    // The list reads the session the canvas hands it; mounted alone, the default one.
    canvasSessions.of('').getState().openTaskPanel('img1', 'failed');
    const { ReactFlow } = await import('@xyflow/react');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ReactFlow nodes={[{ id: 'img1', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
          <NodeTaskPanelContainer
            nodes={[{ id: 'img1', data: { taskCounts: { running: 0, done: 0, failed: 1, expired: 0 } } }] as unknown as React.ComponentProps<typeof NodeTaskPanelContainer>['nodes']}
            projectId={PID}
            spaceId={SID}
            readOnly={false}
            onRetry={vi.fn()}
          />
        </ReactFlow>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByTestId('task-action-clear'));
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('RQ-22 an upload that fails after the Space filled is still reported against its row [F]', async () => {
    const report = vi.spyOn(canvasApi, 'reportNodeTaskFailure').mockResolvedValue({ running: 0, done: 0, failed: 1, expired: 0 } as Awaited<ReturnType<typeof canvasApi.reportNodeTaskFailure>>);
    let fail: (err: unknown) => void = () => undefined;
    ticket.mockResolvedValue({
      uploadId: 'upload-2',
      token: 'token-2',
      storageKey: 'image/2026-11-07/2_next.png',
      uploadUrl: 'https://ingest.example.com',
      kind: 'image',
      partSize: 5 * 1024 * 1024,
      totalParts: 1,
      taskId: 'task-2',
    } as Awaited<ReturnType<typeof assetsApi.requestUploadTicket>>);
    vi.mocked(sendFileAndFinish).mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    mountAt('W');
    fireEvent.contextMenu(nodeElement('img1'));
    fireEvent.click(screen.getByTestId('node-menu-upload'));
    chooseIfOpened(picker, FILE);
    await waitFor(() => expect(ticket).toHaveBeenCalledTimes(1));
    await settle();
    pushSize(NAME, P_FULL);
    await act(async () => {
      fail(new BytesNotDelivered(new Error('network down')));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    await waitFor(() => expect(report).toHaveBeenCalledWith('task-2'));
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
