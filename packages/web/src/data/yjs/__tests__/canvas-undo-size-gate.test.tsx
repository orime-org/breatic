// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 14, canvas half: H-05, H-07, H-10 and the canvas part of H-19.
 *
 * Canvas undo and redo (`useCanvasSpace`'s `undo`/`redo`, the keyboard and the
 * toolbar) go through `nextHistoryStep`, which, once the Space is full, runs
 * the step on a copy of the document and judges what it wrote. Every stack
 * entry is made below the limit (no push), then the state is set.
 *
 * Round 6: the canvas part of H-19 (every entry runs `runHistoryStep`, and
 * over the ceiling the same case says T_OVER) and HC-03 (an empty stack is
 * not tried: no copy of the document, counted as an `encodeStateAsUpdate` of
 * it with `yjs` mocked passing through).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import type * as React from 'react';
import type * as SpaceConnectionModule from '@web/data/yjs/space-connection';
import type { CanvasNodeFields } from '@breatic/shared';
import type * as YModule from 'yjs';
import type * as HistoryStepModule from '@web/data/yjs/history-step';

vi.mock('yjs', async (importOriginal) => {
  const actual = await importOriginal<typeof YModule>();
  return { ...actual, encodeStateAsUpdate: vi.fn(actual.encodeStateAsUpdate) };
});
vi.mock('@web/data/yjs/history-step', async (importOriginal) => {
  const actual = await importOriginal<typeof HistoryStepModule>();
  return {
    ...actual,
    runHistoryStep: vi.fn((...args: Parameters<typeof actual.runHistoryStep>) => actual.runHistoryStep(...args)),
  };
});

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
// provider is the genuine pre-connect state.
vi.mock('@web/data/yjs/use-socket', () => ({
  useSocket: vi.fn(() => ({ provider: null, synced: true, status: 'connected', authFailedReason: null })),
}));
vi.mock('@web/data/yjs/space-connection', async (importOriginal) => {
  const actual = await importOriginal<typeof SpaceConnectionModule>();
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
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  getCanvasUndoManager,
  removeNode,
  setNodeName,
  useCanvasSpace,
  _resetCanvasUndoCacheForTests,
} from '@web/data/yjs/canvas-space';
import { runHistoryStep } from '@web/data/yjs/history-step';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useCanvasStore, useUIStore } from '@web/stores';
import { useCurrentUserStore } from '@web/stores/current-user';
import { canvasSessions } from '@web/stores/canvas-session';
import {
  copiesOf,
  enterSize,
  localUpdate,
  peerOf,
  resetCopies,
  spyOnSteps,
  trialKind,
  type StepSpies,
} from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { COPY_V2_EN, P_FULL, P_OVER, type DocSizePushV2 } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = docName.canvasSpace(PID, SID);

let spies: StepSpies;

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
  manager: Y.UndoManager;
}

/**
 * Opens the canvas with text nodes `t1` and `n2`, then empties the undo stack
 * so only the case's own steps are on it.
 * @returns The board.
 */
function openBoard(): Board {
  const doc = getDoc(NAME);
  act(() => {
    addNode(PID, SID, node('t1', 'text'));
    addNode(PID, SID, node('n2', 'text'));
  });
  const manager = getCanvasUndoManager(doc, NAME);
  manager.clear();
  return { doc, manager };
}

/**
 * Runs a canvas write as its own undo step.
 * @param board - The board.
 * @param write - The write.
 */
function step(board: Board, write: () => void): void {
  act(write);
  board.manager.stopCapturing();
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
 * A node's stored name.
 * @param doc - The canvas document.
 * @param id - Node id.
 * @returns The name.
 */
function nameOf(doc: Y.Doc, id: string): unknown {
  return ((doc.getMap('nodesMap').get(id) as Y.Map<unknown>).get('data') as Y.Map<unknown>).get('name');
}

/**
 * Sets the size state and clears the counters, so only what follows is counted.
 * @param fixture - The push.
 */
function enter(fixture: DocSizePushV2): void {
  enterSize(NAME, fixture);
  spies.undo.mockClear();
  spies.redo.mockClear();
  vi.mocked(toast.warning).mockClear();
}

/**
 * What a refused step must leave untouched.
 * @param board - The board.
 * @returns The document bytes and the stack lengths.
 */
function snapshot(board: Board): [Uint8Array, number, number] {
  return [Y.encodeStateAsUpdate(board.doc), board.manager.undoStack.length, board.manager.redoStack.length];
}

beforeEach(() => {
  changeLocale('en');
  spies = spyOnSteps();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  cleanup();
  spies.restore();
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  _resetForTests();
});

describe('H-05 undoing a creation over the ceiling', () => {
  it('H-05 the trial is a remove; the undo runs and the node goes, no toast', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    step(board, () => { addNode(PID, SID, node('n9', 'text')); });
    enter(P_OVER);

    expect(trialKind(board.manager, 'undo')).toBe('remove');
    spies.undo.mockClear();
    act(() => { hook.result.current.undo(); });

    expect(has(board.doc, 'n9')).toBe(false);
    expect(spies.undo.mock.contexts).toContain(board.manager);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('H-07 a top step a peer emptied is skipped, as yjs skips it', () => {
  it('H-07 create n1, rename n2, a peer deletes n2: over the ceiling the undo removes n1', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    const peer = peerOf(board.doc);
    step(board, () => { addNode(PID, SID, node('n1', 'text')); });
    step(board, () => { setNodeName(PID, SID, 'n2', 'renamed'); });
    peer.getMap('nodesMap').delete('n2');
    expect(has(board.doc, 'n2')).toBe(false);
    enter(P_OVER);

    expect(trialKind(board.manager, 'undo')).toBe('remove');
    act(() => { hook.result.current.undo(); });

    expect(has(board.doc, 'n1')).toBe(false);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('H-10 create, rename, delete, undo the delete, then undo when full', () => {
  it('H-10 the next undo writes the old name back: an add, refused with T_ADD, nothing changes', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    step(board, () => { addNode(PID, SID, node('n1', 'image', { name: 'Image 1' })); });
    step(board, () => { setNodeName(PID, SID, 'n1', 'Hero shot'); });
    step(board, () => { removeNode(PID, SID, 'n1'); });
    act(() => { hook.result.current.undo(); });
    board.manager.stopCapturing();
    expect(nameOf(board.doc, 'n1')).toBe('Hero shot');
    enter(P_FULL);

    expect(trialKind(board.manager, 'undo')).toBe('add');
    vi.mocked(toast.warning).mockClear();
    spies.undo.mockClear();
    const before = snapshot(board);

    const update = localUpdate(board.doc, () => { act(() => { hook.result.current.undo(); }); });

    expect(update).toBeNull();
    expect(snapshot(board)).toEqual(before);
    expect(nameOf(board.doc, 'n1')).toBe('Hero shot');
    expect(spies.undo.mock.contexts).not.toContain(board.manager);
    expect(hook.result.current.canUndo).toBe(true);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
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

describe('H-19 canvas keyboard and toolbar undo and redo all go through the judgement', () => {
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

  it('H-19 Cmd+Z, Ctrl+Z and the toolbar undo of a deletion are each refused when full', async () => {
    renderCanvas();
    const board = openBoard();
    step(board, () => { removeNode(PID, SID, 't1'); });
    enter(P_FULL);
    const before = snapshot(board);

    press('z', { meta: true });
    press('z', { ctrl: true });
    act(() => { useCanvasStore.getState().requestHistoryCommand('undo'); });
    await waitFor(() => expect(useCanvasStore.getState().pendingHistoryCommand).toBeNull());

    expect(has(board.doc, 't1')).toBe(false);
    expect(snapshot(board)).toEqual(before);
    expect(spies.undo.mock.contexts).not.toContain(board.manager);
    // Same sentence three times: collapsing them is lib/toast's job.
    expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual([
      COPY_V2_EN.T_ADD,
      COPY_V2_EN.T_ADD,
      COPY_V2_EN.T_ADD,
    ]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each([
    ['Cmd+Shift+Z', 'z', { meta: true, shift: true }],
    ['Ctrl+Shift+Z', 'z', { ctrl: true, shift: true }],
    ['Ctrl+Y', 'y', { ctrl: true }],
  ] as const)('H-19 %s redoing an undone creation is refused when full', (_label, key, mods) => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    renderCanvas();
    const board = openBoard();
    step(board, () => { addNode(PID, SID, node('n9', 'text')); });
    act(() => { hook.result.current.undo(); });
    expect(has(board.doc, 'n9')).toBe(false);
    enter(P_FULL);
    const before = snapshot(board);

    press(key, mods);

    expect(has(board.doc, 'n9')).toBe(false);
    expect(snapshot(board)).toEqual(before);
    expect(spies.redo.mock.contexts).not.toContain(board.manager);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_V2_EN.T_ADD);
  });
});

describe('H-19 (round 6) the canvas undo entries run runHistoryStep', () => {
  it.each([
    ['full', P_FULL, COPY_V2_EN.T_ADD],
    ['over the ceiling', P_OVER, COPY_V2_EN.T_OVER],
  ] as const)('H-19 useCanvasSpace undo of a deletion %s: runHistoryStep once, refused with its toast, the stacks stay', (_label, fixture, sentence) => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    step(board, () => { removeNode(PID, SID, 't1'); });
    enter(fixture);
    vi.mocked(runHistoryStep).mockClear();
    const before = snapshot(board);

    const update = localUpdate(board.doc, () => { act(() => { hook.result.current.undo(); }); });

    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledWith(NAME, board.manager, 'undo');
    expect(update).toBeNull();
    expect(snapshot(board)).toEqual(before);
    expect(has(board.doc, 't1')).toBe(false);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(sentence);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('HC-03 canvas undo and redo on empty stacks when full', () => {
  it('HC-03 useCanvasSpace undo() and redo(): no copy, nothing written, no toast', () => {
    const hook = renderHook(() => useCanvasSpace(PID, SID));
    const board = openBoard();
    expect(board.manager.undoStack).toHaveLength(0);
    expect(board.manager.redoStack).toHaveLength(0);
    enter(P_FULL);
    resetCopies();

    const update = localUpdate(board.doc, () => {
      act(() => { hook.result.current.undo(); });
      act(() => { hook.result.current.redo(); });
    });

    expect(copiesOf(board.doc)).toBe(0);
    expect(update).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
