// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 8 (W-87–W-89): a dropped non-media
 * file builds an empty text node in an `add` batch, then writes the extracted
 * words through `setNodeExtractedText`, whose refusal is said on the node's own
 * upload mark rather than in a toast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
vi.mock('@web/data/upload/hash', () => ({ hashFile: vi.fn(() => new Promise<string | null>(() => {})) }));
vi.mock('@web/spaces/canvas/text-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/spaces/canvas/text-extract')>();
  return { ...actual, extractText: vi.fn() };
});
// Spread so a spy on the namespace reaches the canvas's own call.
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/yjs/canvas-space')>()),
}));

import { CANVAS_NODES_KEY, formatBytes, setLocale, t } from '@breatic/shared';
import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api';
import { extractText } from '@web/spaces/canvas/text-extract';
import { fillNodeFromFile } from '@web/spaces/canvas/canvas-upload';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { readNodes, readTextBodies, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useUIStore } from '@web/stores';
import { useUploadMarksStore, type UploadMarkMessage } from '@web/stores/upload-marks';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, probe, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  COPY_ZH_CN,
  F_FULL,
  F_WARNING,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

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
 * Drops one plain-text file onto the canvas.
 * @param name - The file name.
 */
function dropText(name: string): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  const files = [new File(['x'], name, { type: 'text/plain' })];
  Object.defineProperty(event, 'dataTransfer', { configurable: true, value: { files, types: ['Files'] } });
  Object.defineProperty(event, 'clientX', { configurable: true, value: 10 });
  Object.defineProperty(event, 'clientY', { configurable: true, value: 10 });
  act(() => {
    screen.getByTestId('canvas-space').dispatchEvent(event);
  });
}

/**
 * Makes `extractText` hand back a promise the test settles.
 * @returns The resolver.
 */
function deferExtract(): (text: string) => void {
  let settle: (text: string) => void = () => undefined;
  vi.mocked(extractText).mockReturnValue(new Promise<string>((resolve) => { settle = resolve; }));
  return (text) => settle(text);
}

/**
 * The largest byte count that fits right now, found by probing.
 * @returns The available room.
 */
function availableRoom(): number {
  let lo = 0;
  let hi = F_WARNING.room;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (probe(NAME, mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * How a mark message reads on screen, the way the node renders it.
 * @param message - The mark's message.
 * @returns The sentence.
 */
function rendered(message: UploadMarkMessage): string {
  return 'text' in message ? message.text : t(message.key, message.params);
}

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
});

afterEach(() => {
  cleanup();
  setLocale('en');
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-87 a full Space refuses the whole drop', () => {
  it('builds no node, warns once, reads nothing and leaves no upload mark', async () => {
    deferExtract();
    const doc = mountAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    dropText('notes.txt');
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(doc.getMap(CANVAS_NODES_KEY).size).toBe(0);
    expect(extractText).not.toHaveBeenCalled();
    expect(useUploadMarksStore.getState().marks[SID] ?? {}).toEqual({});
  });
});

describe('W-88 extracted words that do not fit fail on the node', () => {
  it.each([
    ['en', COPY_EN.T_TEXT_NO_ROOM],
    ['zh-CN', COPY_ZH_CN.T_TEXT_NO_ROOM],
  ] as const)('keeps the empty node and says why on it (%s)', async (locale, sentence) => {
    setLocale(locale);
    const write = vi.spyOn(canvasSpace, 'setNodeExtractedText');
    const settle = deferExtract();
    const doc = mountAt(F_WARNING);
    dropText('big.txt');
    await waitFor(() => expect(readNodes(doc).filter((n) => n.type === 'text')).toHaveLength(1));
    const id = readNodes(doc).find((n) => n.type === 'text')!.id;
    const room = availableRoom();
    await act(async () => {
      settle('a'.repeat(800000));
      await Promise.resolve();
    });
    await waitFor(() => expect(useUploadMarksStore.getState().markOf(SID, id)?.state).toBe('failed'));
    expect(readTextBodies(PID, SID, [id]).get(id)).toBe('');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.results[0].value).toEqual({ ok: false, reason: 'no_room', room });
    const mark = useUploadMarksStore.getState().markOf(SID, id);
    if (mark?.state !== 'failed') throw new Error('the node has no failure mark');
    expect(mark.message).toMatchObject({ params: { room: formatBytes(room) } });
    expect(rendered(mark.message)).toBe(sentence(formatBytes(room)));
    const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
    expect(within(node).getByTestId('node-upload-error')).toHaveTextContent(sentence(formatBytes(room)));
    expect(screen.queryByText(t('canvas.upload.extractionFailed', { filename: 'big.txt' }))).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-89 extracted words that fit are written', () => {
  it('fills the node body and clears the mark without a toast', async () => {
    const settle = deferExtract();
    const doc = mountAt(F_WARNING);
    dropText('small.txt');
    await waitFor(() => expect(readNodes(doc).filter((n) => n.type === 'text')).toHaveLength(1));
    const id = readNodes(doc).find((n) => n.type === 'text')!.id;
    await act(async () => {
      settle('hello');
      await Promise.resolve();
    });
    await waitFor(() => expect(readTextBodies(PID, SID, [id]).get(id)).toBe('hello'));
    expect(useUploadMarksStore.getState().markOf(SID, id)).toBeUndefined();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-89 fillNodeFromFile ends the mark by what setContent answered', () => {
  /**
   * Fills an existing text node through the double-click / Upload path.
   * @param answer - What the content write answers.
   * @returns The node's mark afterwards.
   */
  async function fillWith(answer: unknown): Promise<ReturnType<ReturnType<typeof useUploadMarksStore.getState>['markOf']>> {
    useUploadMarksStore.setState({ marks: {} });
    const op = useUploadMarksStore.getState().begin('s1', 'n1', 'readText');
    await fillNodeFromFile('n1', new File(['x'], 'notes.txt', { type: 'text/plain' }), 'text', 'p1', {
      getUploadConfig: vi.fn(),
      hashFile: vi.fn(),
      requestTicket: vi.fn(),
      sendToIngest: vi.fn(),
      extractText: vi.fn().mockResolvedValue('hello'),
      setContent: vi.fn(() => answer) as (nodeId: string, content: string) => void,
      spaceId: 's1',
      markOp: op,
      onUploadFailure: vi.fn(),
    });
    return useUploadMarksStore.getState().markOf('s1', 'n1');
  }

  it('fails the mark with the no-room sentence', async () => {
    const mark = await fillWith({ ok: false, reason: 'no_room', room: 1 });
    if (mark?.state !== 'failed') throw new Error(`expected a failed mark, got ${JSON.stringify(mark)}`);
    expect(rendered(mark.message)).toBe(COPY_EN.T_TEXT_NO_ROOM('1 B'));
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('fails the mark with the full sentence', async () => {
    const mark = await fillWith({ ok: false, reason: 'full' });
    if (mark?.state !== 'failed') throw new Error(`expected a failed mark, got ${JSON.stringify(mark)}`);
    expect(rendered(mark.message)).toBe(COPY_EN.T_TEXT_FULL);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('answers the mark when the write went through', async () => {
    expect(await fillWith({ ok: true })).toBeUndefined();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
