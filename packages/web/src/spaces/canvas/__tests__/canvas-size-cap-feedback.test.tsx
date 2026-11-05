// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790) on the mounted canvas: W-135 (a viewer
 * never hears a size toast) and W-148 (the Space fills up between creating a
 * dropped text file's node and writing its text).
 *
 * The canvas is mounted as `CanvasSpace.test.tsx` mounts it: the Yjs binding
 * hook is stood in for and reads the real document on every render, while the
 * write helpers stay real. Size pushes arrive on the provider stand-in of the
 * canvas document, as collab sends them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';
import * as Y from 'yjs';
import { spaceContentDocName, t } from '@breatic/shared';
import { bodyToPlainText } from '@breatic/shared/canvas/text-body';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()),
);
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@web/data/yjs/canvas-space')>();
  return {
    ...actual,
    useCanvasSpace: vi.fn(),
    // Real, and recorded, so its result can be read (W-148).
    setNodeExtractedText: vi.fn(actual.setNodeExtractedText),
  };
});
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: false, status: 'connecting', authFailedReason: null })),
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
vi.mock('@web/data/api/users', () => ({ usersApi: { getByIds: () => Promise.resolve([]) } }));
// The extraction is held open so the push can land between the node and its text.
const extraction = vi.hoisted(() => ({ resolve: (_text: string): void => undefined }));
vi.mock('@web/spaces/canvas/text-extract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/spaces/canvas/text-extract')>()),
  extractText: vi.fn(
    () =>
      new Promise<string>((resolve) => {
        extraction.resolve = resolve;
      }),
  ),
}));

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { addNode, getTextBody, readNodes, setNodeExtractedText } from '@web/data/yjs/canvas-space';
import { extractText } from '@web/spaces/canvas/text-extract';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { assetsApi } from '@web/data/api';
import { canvasApi } from '@web/data/api/canvas';
import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { useCanvasStore, useUIStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { canvasSessions } from '@web/stores/canvas-session';
import { latestProvider, push, resetProviderSpies } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { COPY_EN, COPY_ZH_CN, F_FULL, F_WARNING } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const NAME = spaceContentDocName('p', 's', 'canvas');

type Board = ReturnType<typeof canvasSpace.useCanvasSpace>;

/**
 * A full binding-hook result over these nodes.
 * @param nodes - What the board shows.
 * @returns The hook result.
 */
function space(nodes: Board['nodes']): Board {
  return {
    nodes,
    edges: [],
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: true,
    canRedo: true,
    getLastWriteWasLocal: () => true,
    deletedByPeer: () => false,
  } as unknown as Board;
}

let board: Board;

/**
 * Puts the real document's nodes on the board and re-renders.
 * @param rerender - The render result's rerender.
 */
function showDocument(rerender: () => void): void {
  board = space([...readNodes(getDoc(NAME))] as Board['nodes']);
  act(() => {
    rerender();
  });
}

/**
 * Whether a shown toast is one of the size-cap sentences of spec 0.5 (the
 * cases run in English), whatever figures it carries.
 * @param text - The toast text.
 * @returns True for a size sentence.
 */
function isSizeSentence(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const fixed = Object.values(COPY_EN).filter((v): v is string => typeof v === 'string');
  if (fixed.includes(text)) return true;
  // The sentences with figures in them, figures left open.
  return /^This Space is using .+ of its .+\.$|^This Space is full \(.+ of .+\)\.|the Space has .+ left/.test(text);
}

/**
 * Mounts the canvas inside a query client and the space region, as the page does.
 * @param readOnly - Mount it for a viewer.
 * @returns The render result.
 */
function renderSpace(readOnly: boolean): ReturnType<typeof render> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(element(readOnly));
}

let client: QueryClient;

/**
 * The canvas inside the current query client and the space region.
 * @param readOnly - Mount it for a viewer.
 * @returns The element.
 */
function element(readOnly: boolean): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <div data-region='space'>
        <CanvasSpace projectId='p' spaceId='s' readOnly={readOnly} />
      </div>
    </QueryClientProvider>
  );
}

/**
 * A key press at the focused element, as a browser aims it.
 * @param key - `KeyboardEvent.key`.
 * @param mods - Modifiers.
 * @param mods.meta - Cmd.
 * @param mods.ctrl - Ctrl.
 */
function press(key: string, mods: { meta?: boolean; ctrl?: boolean } = {}): void {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, metaKey: mods.meta ?? false, ctrlKey: mods.ctrl ?? false, bubbles: true, cancelable: true }),
    );
  });
}

/**
 * A paste of clipboard text at the focused element.
 * @param text - The `text/plain` payload.
 */
function paste(text: string): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: { getData: (type: string): string => (type === 'text/plain' ? text : ''), files: [] },
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
}

/**
 * Drops files on the canvas surface.
 * @param files - The files.
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

beforeEach(() => {
  changeLocale('en');
  canvasSessions.of('s').setState({ panelHostId: null, panelKind: null, pickSession: null });
  useUIStore.setState({ activeRegion: 'space' });
  useCanvasStore.setState({ pendingNodeCreate: null, pendingViewportCommand: null, pendingHistoryCommand: null, canUndo: false, canRedo: false });
  useSpaceOperationsStore.setState({ operations: {} });
  useUploadMarksStore.setState({ marks: {} });
  useCurrentUserStore.getState().setUser({ id: 'u-1', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(setNodeExtractedText).mockClear();
  vi.mocked(extractText).mockClear();
  vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {} });
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({
    maxUploadBytes: 2147483648,
    clientMaxAttempts: 1,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 60000,
    uploadStatusPollSeconds: 2,
    assetUrlPrefix: 'https://cdn/',
  });
  // What the board shows; a case refreshes it from the real document with
  // `showDocument` when it wants new nodes on screen. One object between
  // refreshes, as the real hook keeps one between changes.
  board = space([]);
  vi.mocked(canvasSpace.useCanvasSpace).mockImplementation(() => board);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
});

describe('W-135 a viewer never hears a size toast', () => {
  it('paste, undo and delete on a full canvas leave the document and say nothing about size', () => {
    addNode('p', 's', {
      id: 't1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { name: 'T', createdAt: 1, createdBy: 'u', locked: false, attachments: [] },
    });
    const doc = getDoc(NAME);
    acquireDocProvider(NAME, doc);
    push(latestProvider(NAME), F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    board = space([...readNodes(doc)] as Board['nodes']);
    renderSpace(true);

    paste('plain words from somewhere else');
    press('v', { meta: true });
    press('v', { ctrl: true });
    press('z', { meta: true });
    press('z', { ctrl: true });
    press('Delete');
    press('Backspace');

    const sizeToasts = vi.mocked(toast.warning).mock.calls.filter(([text]) => isSizeSentence(text));
    expect(sizeToasts).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(readNodes(doc).map((n) => n.id)).toEqual(['t1']);
  });
});

describe.each([
  ['en', COPY_EN.T_TEXT_FULL],
  ['zh-CN', COPY_ZH_CN.T_TEXT_FULL],
] as const)('W-148 the Space fills up before a dropped file\'s text is written (%s)', (locale, sentence) => {
  it('leaves the node empty and says on its upload mark that the Space is full', async () => {
    changeLocale(locale);
    const doc = getDoc(NAME);
    acquireDocProvider(NAME, doc);
    const provider = latestProvider(NAME);
    push(provider, F_WARNING);
    const view = renderSpace(false);

    drop([new File(['hello'], 'notes.txt', { type: 'text/plain' })]);

    await waitFor(() => expect(extractText).toHaveBeenCalledTimes(1));
    const created = readNodes(doc);
    expect(created.map((n) => n.type)).toEqual(['text']);
    const nodeId = created[0].id;

    push(provider, F_FULL);
    await act(async () => {
      extraction.resolve('hello');
      await Promise.resolve();
      await Promise.resolve();
    });

    // The node stays, with nothing written into it.
    expect(readNodes(doc).map((n) => n.id)).toEqual([nodeId]);
    const body = getTextBody('p', 's', nodeId);
    expect(body === null ? '' : bodyToPlainText(body as Y.XmlFragment)).toBe('');

    // The write was refused because the Space is full, not for lack of room.
    expect(setNodeExtractedText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setNodeExtractedText).mock.results[0].value).toEqual({ ok: false, reason: 'full' });

    // The node's own upload mark carries the sentence.
    const mark = useUploadMarksStore.getState().markOf('s', nodeId);
    expect(mark?.state).toBe('failed');
    const message = mark?.state === 'failed' ? mark.message : undefined;
    expect(message !== undefined && 'key' in message).toBe(true);
    if (message === undefined || !('key' in message)) return;
    expect(message.key).not.toBe('canvas.upload.extractionFailed');
    expect(t(message.key, message.params)).toBe(sentence);
    showDocument(() => {
      view.rerender(element(false));
    });
    expect(await screen.findByText(sentence)).toBeInTheDocument();

    const extractionFailed = t('canvas.upload.extractionFailed', { filename: 'notes.txt' });
    expect(screen.queryByText(extractionFailed)).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
