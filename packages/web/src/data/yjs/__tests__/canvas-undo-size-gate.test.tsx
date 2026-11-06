// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 11, canvas half: undo and redo are
 * judged at the command layer before the undo manager runs.
 *
 * The stack item about to run decides the kind: no deletions to restore is a
 * `delete`, restoring only the values of keys that still exist is an
 * `overwrite`, anything else is an `add`. A refused undo or redo never calls
 * `Y.UndoManager#undo/redo`, so the stacks and the document stay as they were.
 * Every stack entry is made under `F_NORMAL`, then the target phase is pushed.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';
import { spaceContentDocName, type CanvasNodeFields } from '@breatic/shared';

vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: {
    warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(),
    loading: vi.fn(), promise: vi.fn(), dismiss: vi.fn(), custom: vi.fn(),
  },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
// CanvasSpace reads its caret channel from the tab's connection; a null
// provider is the genuine pre-connect state. The size pushes travel on the
// provider `acquireDocProvider` builds, which is the registry under test.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: true, status: 'connected', authFailedReason: null })),
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
vi.mock('@web/data/api/users', () => ({
  usersApi: { getByIds: () => Promise.resolve([]) },
}));

import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  CANVAS_UNDO,
  addNode,
  getCanvasUndoManager,
  removeNode,
  setGroupBackground,
  setNodePosition,
  useCanvasSpace,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useCanvasStore, useUIStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';
import { canvasSessions } from '@web/stores/canvas-session';
import {
  push,
  refuse,
  resetProviderSpies,
  type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import {
  COPY_EN,
  F_FULL,
  F_FULL_NEAR,
  F_NORMAL,
  F_WARNING,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = spaceContentDocName(PID, SID, 'canvas');

let undoSpy: MockInstance;
let redoSpy: MockInstance;

/**
 * Wire fields every seeded node carries.
 * @param id - Node id.
 * @param type - Node modality.
 * @param data - Extra data fields.
 * @returns The node.
 */
function node(id: string, type: string, data: Record<string, unknown> = {}): CanvasNodeFields {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [], ...data },
  } as CanvasNodeFields;
}

/** The open canvas under test. */
interface Board {
  doc: Y.Doc;
  provider: ProviderSpy;
  manager: Y.UndoManager;
}

/**
 * Opens the canvas, pushes `F_NORMAL`, seeds text `t1` and blue group `g1`,
 * then empties the undo stack so only the case's own steps are on it.
 * @returns The board.
 * @throws {Error} When seeding fails.
 */
function openBoard(): Board {
  const doc = getDoc(NAME);
  const provider = acquireDocProvider(NAME, doc) as unknown as ProviderSpy;
  push(provider, F_NORMAL);
  act(() => {
    addNode(PID, SID, node('t1', 'text'));
    addNode(PID, SID, node('g1', 'group', { backgroundColor: 'blue', width: 400, height: 300 }));
  });
  const manager = getCanvasUndoManager(doc, NAME);
  manager.clear();
  return { doc, provider, manager };
}

/**
 * Whether the board holds a node.
 * @param doc - The canvas document.
 * @param id - Node id.
 * @returns True when the node is in `nodesMap`.
 */
function has(doc: Y.Doc, id: string): boolean {
  return doc.getMap('nodesMap').has(id);
}

/**
 * A node's stored position.
 * @param doc - The canvas document.
 * @param id - Node id.
 * @returns The position value.
 */
function positionOf(doc: Y.Doc, id: string): unknown {
  return (doc.getMap('nodesMap').get(id) as Y.Map<unknown>).get('position');
}

/**
 * Pushes a phase and clears the spies, so only what follows is counted.
 * @param board - The board.
 * @param fixture - The push.
 */
function enter(board: Board, fixture: DocSizePush): void {
  push(board.provider, fixture);
  undoSpy.mockClear();
  redoSpy.mockClear();
  vi.mocked(toast.warning).mockClear();
}

beforeEach(() => {
  changeLocale('en');
  undoSpy = vi.spyOn(Y.UndoManager.prototype, 'undo');
  redoSpy = vi.spyOn(Y.UndoManager.prototype, 'redo');
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  undoSpy.mockRestore();
  redoSpy.mockRestore();
  _resetCollabSocketForTests();
  _resetCanvasUndoCacheForTests();
  _resetForTests();
  resetProviderSpies();
});

describe('W-111 the four stack-entry cases on the canvas', () => {
  it('(a) undoing a creation under full is a delete: n9 is removed, no toast', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { addNode(PID, SID, node('n9', 'text')); });
    enter(board, F_FULL);

    act(() => { hook.result.current.undo(); });

    expect(has(board.doc, 'n9')).toBe(false);
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('(b) undoing a deletion under full is an add: refused, t1 stays gone, undo stays available', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { removeNode(PID, SID, 't1'); });
    enter(board, F_FULL);
    const before = Y.encodeStateAsUpdate(board.doc);
    const stacks = [board.manager.undoStack.length, board.manager.redoStack.length];

    act(() => { hook.result.current.undo(); });

    expect(has(board.doc, 't1')).toBe(false);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(undoSpy).not.toHaveBeenCalled();
    expect([board.manager.undoStack.length, board.manager.redoStack.length]).toEqual(stacks);
    expect(hook.result.current.canUndo).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('(e) undoing a deletion in warning with less room than it brings back is refused with the room left', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { removeNode(PID, SID, 't1'); });
    enter(board, { ...F_WARNING, room: 1 });

    act(() => { hook.result.current.undo(); });

    expect(has(board.doc, 't1')).toBe(false);
    expect(undoSpy).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    // The room it names is what is left after the board's own pending writes.
    expect(vi.mocked(toast.warning).mock.calls[0]![0]).toMatch(/^This doesn't fit — the Space has \d+ B left\.$/);
  });

  it('(c) redoing a creation under full is an add: refused, n9 stays absent', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { addNode(PID, SID, node('n9', 'text')); });
    act(() => { hook.result.current.undo(); });
    expect(has(board.doc, 'n9')).toBe(false);
    enter(board, F_FULL);
    const before = Y.encodeStateAsUpdate(board.doc);
    const stacks = [board.manager.undoStack.length, board.manager.redoStack.length];

    act(() => { hook.result.current.redo(); });

    expect(has(board.doc, 'n9')).toBe(false);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(redoSpy).not.toHaveBeenCalled();
    expect([board.manager.undoStack.length, board.manager.redoStack.length]).toEqual(stacks);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('(d) redoing a deletion under full is a delete: t1 is removed, no toast', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { removeNode(PID, SID, 't1'); });
    act(() => { hook.result.current.undo(); });
    expect(has(board.doc, 't1')).toBe(true);
    enter(board, F_FULL);

    act(() => { hook.result.current.redo(); });

    expect(has(board.doc, 't1')).toBe(false);
    expect(redoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-112 restoring only the value of an existing key is an overwrite', () => {
  it('(a) under F_FULL (overwrite room left) undoing a move restores the position, no toast', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    const original = positionOf(board.doc, 't1');
    act(() => { setNodePosition(PID, SID, 't1', { x: 120, y: 80 }, null); });
    enter(board, F_FULL);

    act(() => { hook.result.current.undo(); });

    expect(positionOf(board.doc, 't1')).toEqual(original);
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('(b) under F_FULL_NEAR (no overwrite room) undoing a move is refused', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { setNodePosition(PID, SID, 't1', { x: 120, y: 80 }, null); });
    enter(board, F_FULL_NEAR);
    const before = Y.encodeStateAsUpdate(board.doc);
    const stacks = [board.manager.undoStack.length, board.manager.redoStack.length];

    act(() => { hook.result.current.undo(); });

    expect(positionOf(board.doc, 't1')).toEqual({ x: 120, y: 80 });
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(undoSpy).not.toHaveBeenCalled();
    expect([board.manager.undoStack.length, board.manager.redoStack.length]).toEqual(stacks);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_EN.T_OVERWRITE_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-113 restoring a key that no longer exists is an add', () => {
  it('undoing the removal of a group background under F_FULL is refused', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    act(() => { setGroupBackground(PID, SID, 'g1', undefined); });
    const data = (board.doc.getMap('nodesMap').get('g1') as Y.Map<unknown>).get('data') as Y.Map<unknown>;
    expect(data.has('backgroundColor')).toBe(false);
    enter(board, F_FULL);
    const before = Y.encodeStateAsUpdate(board.doc);

    act(() => { hook.result.current.undo(); });

    expect(data.has('backgroundColor')).toBe(false);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(undoSpy).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

/**
 * Mounts the real canvas over the real `useCanvasSpace`.
 * @returns The render result.
 */
function renderCanvas(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <div data-region='space'>
        <CanvasSpace projectId={PID} spaceId={SID} readOnly={false} />
      </div>
    </QueryClientProvider>,
  );
}

/**
 * Dispatches a key press where a browser aims it (the focused element or body).
 * @param key - `KeyboardEvent.key`.
 * @param mods - Modifier flags.
 */
function press(key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean }): void {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: mods.meta ?? false,
        ctrlKey: mods.ctrl ?? false,
        shiftKey: mods.shift ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe('W-114 keyboard and toolbar paths are both gated (both platforms)', () => {
  beforeEach(() => {
    canvasSessions.of(SID).setState({ panelHostId: null, panelKind: null, pickSession: null });
    useUIStore.setState({ activeRegion: 'space' });
    useCanvasStore.setState({
      pendingNodeCreate: null,
      pendingViewportCommand: null,
      pendingHistoryCommand: null,
      canUndo: false,
      canRedo: false,
    });
    useCurrentUserStore.getState().setUser({
      id: 'u-1',
      name: 'Ada',
      email: 'ada@example.com',
      personalStudio: null,
      membershipTier: 'base',
    });
  });

  it('(a)(b)(c) Cmd+Z, Ctrl+Z and the toolbar undo of a deletion are each refused under F_FULL', async () => {
    renderCanvas();
    const board = openBoard();
    act(() => { removeNode(PID, SID, 't1'); });
    enter(board, F_FULL);
    const before = Y.encodeStateAsUpdate(board.doc);
    const stacks = [board.manager.undoStack.length, board.manager.redoStack.length];

    press('z', { meta: true });
    press('z', { ctrl: true });
    act(() => { useCanvasStore.getState().requestHistoryCommand('undo'); });
    await waitFor(() => expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull());

    expect(has(board.doc, 't1')).toBe(false);
    expect(Y.encodeStateAsUpdate(board.doc)).toEqual(before);
    expect(undoSpy).not.toHaveBeenCalled();
    expect([board.manager.undoStack.length, board.manager.redoStack.length]).toEqual(stacks);
    // Same sentence three times: collapsing them is lib/toast's job, so the
    // gate itself calls warning once per refused press.
    expect(toast.warning).toHaveBeenCalledTimes(3);
    expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([
      COPY_EN.T_ADD_BLOCKED,
      COPY_EN.T_ADD_BLOCKED,
      COPY_EN.T_ADD_BLOCKED,
    ]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['Cmd+Shift+Z', 'z', { meta: true, shift: true }],
    ['Ctrl+Shift+Z', 'z', { ctrl: true, shift: true }],
    ['Ctrl+Y', 'y', { ctrl: true }],
  ] as const)('(d) %s redoes a deletion under F_FULL (a delete runs)', (_label, key, mods) => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    renderCanvas();
    const board = openBoard();
    act(() => { removeNode(PID, SID, 't1'); });
    act(() => { hook.result.current.undo(); });
    expect(has(board.doc, 't1')).toBe(true);
    enter(board, F_FULL);

    press(key, mods);

    expect(has(board.doc, 't1')).toBe(false);
    expect(redoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-117 undo while resyncing and while the size is unknown', () => {
  it('(a) while resyncing both an undo of a creation and of a deletion are refused, with no toast besides the resync one', () => {
    const first = getDoc(NAME);
    const oldProvider = acquireDocProvider(NAME, first) as unknown as ProviderSpy;
    push(oldProvider, F_NORMAL);
    refuse(oldProvider);

    // The rebuilt document; its provider has not synced yet.
    const doc = getDoc(NAME);
    expect(doc).not.toBe(first);
    acquireDocProvider(NAME, doc);
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const manager = getCanvasUndoManager(doc, NAME);
    const nodesMap = doc.getMap<Y.Map<unknown>>('nodesMap');

    // Stack entries built straight on the document (bypassing the write
    // gateway, which refuses everything while resyncing), only to have
    // something on the stack.
    act(() => {
      doc.transact(() => {
        const entry = new Y.Map<unknown>();
        entry.set('id', 'n9');
        entry.set('type', 'text');
        entry.set('position', { x: 0, y: 0 });
        nodesMap.set('n9', entry);
      }, CANVAS_UNDO);
    });
    undoSpy.mockClear();
    const afterCreate = Y.encodeStateAsUpdate(doc);
    const createStacks = [manager.undoStack.length, manager.redoStack.length];

    act(() => { hook.result.current.undo(); });

    expect(undoSpy).not.toHaveBeenCalled();
    expect(nodesMap.has('n9')).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(afterCreate);
    expect([manager.undoStack.length, manager.redoStack.length]).toEqual(createStacks);

    act(() => { doc.transact(() => { nodesMap.delete('n9'); }, CANVAS_UNDO); });
    undoSpy.mockClear();
    const afterDelete = Y.encodeStateAsUpdate(doc);
    const deleteStacks = [manager.undoStack.length, manager.redoStack.length];

    act(() => { hook.result.current.undo(); });

    expect(undoSpy).not.toHaveBeenCalled();
    expect(nodesMap.has('n9')).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(afterDelete);
    expect([manager.undoStack.length, manager.redoStack.length]).toEqual(deleteStacks);

    const others = vi.mocked(toast.warning).mock.calls.filter(([message]) => message !== COPY_EN.T_RESYNC);
    expect(others).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('(b) with no push yet, undoing a deletion restores t1, no toast', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const doc = getDoc(NAME);
    acquireDocProvider(NAME, doc);
    act(() => { addNode(PID, SID, node('t1', 'text')); });
    getCanvasUndoManager(doc, NAME).clear();
    act(() => { removeNode(PID, SID, 't1'); });

    act(() => { hook.result.current.undo(); });

    expect(has(doc, 't1')).toBe(true);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
