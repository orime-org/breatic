// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-55: dropping files onto the canvas builds
 * its nodes and their Group in one `runCanvasUndoBatch` of kind `add`, so a
 * full Space refuses the whole drop before anything is uploaded or read.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
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
// Never settle: what happens after the batch is out of scope here, only
// whether the pipeline was entered at all.
vi.mock('@web/data/upload/hash', () => ({ hashFile: vi.fn(() => new Promise<string | null>(() => {})) }));
vi.mock('@web/spaces/canvas/text-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/text-extract')>();
  return { ...actual, extractText: vi.fn(() => new Promise<string>(() => {})) };
});

import { CANVAS_NODES_KEY } from '@breatic/shared';
import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api';
import { hashFile } from '@web/data/upload/hash';
import { extractText } from '@web/spaces/canvas/text-extract';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { readNodes, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useUIStore } from '@web/stores';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import { COPY_EN, F_FULL, F_NORMAL, type DocSizePush } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p';
const SID = 's';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Opens the canvas document, delivers one push and mounts the real canvas on it.
 * @param push - The size push.
 * @returns The canvas document.
 * @throws {Error} When mounting fails.
 */
function mountAt(push: DocSizePush): Y.Doc {
  const { doc, provider } = openSizedDoc(NAME);
  pushSize(provider, push);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
    </QueryClientProvider>,
  );
  return doc;
}

/**
 * Drops files onto the canvas the way the browser hands them over.
 * @param files - The dropped files.
 */
function drop(files: File[]): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { configurable: true, value: { files, types: ['Files'] } });
  Object.defineProperty(event, 'clientX', { configurable: true, value: 10 });
  Object.defineProperty(event, 'clientY', { configurable: true, value: 10 });
  act(() => {
    screen.getByTestId('canvas-space').dispatchEvent(event);
  });
}

/**
 * The two files of every case: a picture and a plain-text file.
 * @returns The files.
 */
function twoFiles(): File[] {
  return [new File(['x'], 'a.png', { type: 'image/png' }), new File(['hello'], 'b.txt', { type: 'text/plain' })];
}

let ticket: MockInstance<typeof assetsApi.requestUploadTicket>;

beforeEach(() => {
  sizeGateProviders.length = 0;
  useUIStore.setState({ activeRegion: 'space' });
  useUploadMarksStore.setState({ marks: {} });
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({
    maxUploadBytes: 2147483648,
    clientMaxAttempts: 1,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 60000,
    uploadStatusPollSeconds: 2,
    assetUrlPrefix: 'https://cdn/',
  });
  ticket = vi.spyOn(assetsApi, 'requestUploadTicket').mockReturnValue(new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-55 dropping files is one add batch', () => {
  it('builds no node and no Group, warns once and starts no upload when the Space is full', async () => {
    const doc = mountAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    drop(twoFiles());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBe(0);
    expect(ticket).not.toHaveBeenCalled();
    expect(hashFile).not.toHaveBeenCalled();
    expect(extractText).not.toHaveBeenCalled();
    expect(useUploadMarksStore.getState().marks[SID] ?? {}).toEqual({});
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('builds both nodes inside a Group named for the batch when there is room', async () => {
    const doc = mountAt(F_NORMAL);
    drop(twoFiles());
    await waitFor(() => expect(readNodes(doc)).toHaveLength(3));
    const nodes = readNodes(doc);
    const group = nodes.find((n) => n.type === 'group');
    expect(group?.data).toMatchObject({ name: '2 files' });
    expect(nodes.filter((n) => n.type !== 'group').map((n) => [n.type, n.parentId])).toEqual(
      expect.arrayContaining([['image', group!.id], ['text', group!.id]]),
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
