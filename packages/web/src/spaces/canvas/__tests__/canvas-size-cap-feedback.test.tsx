// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap v2 (inner#1790 v2 web test spec V-01, canvas part):
 * a viewer of a full canvas never hears a size toast. The dropped-text-file
 * case lives in `drop-text-file-size-gate.test.tsx` (RQ-21).
 *
 * The canvas is mounted as `CanvasSpace.test.tsx` mounts it: the Yjs binding
 * hook is stood in for and reads the real document on every render, while the
 * write helpers stay real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';
import * as Y from 'yjs';
import { spaceContentDocName } from '@breatic/shared';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
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
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock('@web/data/api/users', () => ({ usersApi: { getByIds: () => Promise.resolve([]) } }));
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { addNode, readNodes } from '@web/data/yjs/canvas-space';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
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
import { SIZE_COPY_EN, enterSize } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

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
 * Whether a shown toast is one of the size-cap sentences of spec 0.5 (the
 * cases run in English), whatever figures it carries.
 * @param text - The toast text.
 * @returns True for a size sentence.
 */
function isSizeSentence(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return (Object.values(SIZE_COPY_EN) as string[]).includes(text) || /^This Space is (using|full \(|over its limit \()/.test(text);
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
  vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {}, media: {} });
  vi.spyOn(assetsApi, 'fetchUploadConfig').mockResolvedValue({
    maxUploadBytes: 2147483648,
    clientMaxAttempts: 1,
    clientRetryBaseDelayMs: 1,
    uploadIdleTimeoutMs: 60000,
    uploadStatusPollSeconds: 2,
    assetUrlPrefix: 'https://cdn/',
  });
  // What the board shows; a case refreshes it from the real document with
  // the real document when it wants new nodes on screen. One object between
  // refreshes, as the real hook keeps one between changes.
  board = space([]);
  vi.mocked(canvasSpace.useCanvasSpace).mockImplementation(() => board);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _resetCollabSocketForTests();
  _resetForTests();
  clearAllDocSizes();
});

describe('V-01 (canvas) a viewer never hears a size toast', () => {
  it.each(['F', 'O'] as const)('V-01 paste, undo and delete on a full canvas leave the document and say nothing about size [%s]', (code) => {
    addNode('p', 's', {
      id: 't1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { name: 'T', createdAt: 1, createdBy: 'u', locked: false, attachments: [] },
    });
    const doc = getDoc(NAME);
    enterSize(NAME, code);
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
