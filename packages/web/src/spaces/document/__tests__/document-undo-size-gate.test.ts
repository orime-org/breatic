// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 11, W-115: the document body's
 * undo and redo are judged at the command layer.
 *
 * BlockNote calls the y-prosemirror undo manager straight from its commands
 * (and `document-body-press.ts` calls `editor.undo()` while the scroller has
 * the focus), so the gate has to sit in the commands handed to BlockNote:
 * restoring a deleted block is an `add` and is refused once the Space is full,
 * taking typed text back is a `delete` and always runs. Entries are made under
 * `F_NORMAL`, then the target phase is pushed.
 *
 * Keys go through `view.someProp('handleKeyDown')`. jsdom is not a Mac, so the
 * editor's `Mod` binds to Ctrl there; which modifier `Mod` is in this process
 * is read from the keymap itself rather than assumed. The scroller path
 * matches either modifier and is driven with both.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import { TextSelection } from '@tiptap/pm/state';
import { keydownHandler } from '@tiptap/pm/keymap';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent, spaceContentDocName } from '@breatic/shared';

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

import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { attachBodyScroller } from '@web/spaces/document/document-body-press';
import { push, resetProviderSpies, type ProviderSpy } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { COPY_EN, F_FULL, F_NORMAL } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '33333333-3333-4333-8333-333333333333';
const NAME = spaceContentDocName(PID, SID, 'document');

/** Whether this process's keymap reads `Mod` as Meta (a Mac platform) or Ctrl. */
const MOD_IS_META = keydownHandler({ 'Mod-z': () => true })(
  {} as EditorView,
  new KeyboardEvent('keydown', { key: 'z', metaKey: true }),
);

let undoSpy: MockInstance;
let redoSpy: MockInstance;
const containers: HTMLElement[] = [];
const detachers: Array<() => void> = [];

/** An open body and the facts the cases compare. */
interface Body {
  handle: DocumentEditorHandle;
  doc: Y.Doc;
  provider: ProviderSpy;
  view: EditorView;
}

/**
 * Opens the document body through the editor cache, pushes `F_NORMAL`, writes
 * the paragraphs `hello world` and `second`, and empties the undo stack.
 * @returns The body.
 * @throws {Error} When the editor cannot be built.
 */
function openBody(): Body {
  const doc = getDoc(NAME);
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const provider = acquireDocProvider(NAME, doc) as unknown as ProviderSpy;
  push(provider, F_NORMAL);
  const handle = getDocumentEditor(doc, NAME, {
    caretProvider: { awareness: new Awareness(doc) },
    readWho: () => ({ role: 'owner', viewerId: 'u1' }),
    editable: true,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  adoptDocumentEditor(handle, container);
  act(() => {
    handle.editor.replaceBlocks(handle.editor.document, [
      { type: 'paragraph', content: 'hello world' } as never,
      { type: 'paragraph', content: 'second' } as never,
    ]);
  });
  handle.undoManager.stopCapturing();
  handle.undoManager.clear();
  return { handle, doc, provider, view: handle.editor.prosemirrorView! };
}

/**
 * The text of every top-level block, in order.
 * @param body - The body.
 * @returns One string per block.
 */
function blocks(body: Body): string[] {
  return docBlocks(body).map((block) =>
    ((block.content ?? []) as Array<{ text?: string }>).map((run) => run.text ?? '').join(''));
}

/**
 * Presses a key inside the editor.
 * @param body - The body.
 * @param key - `KeyboardEvent.key`.
 * @param mods - Modifiers; `mod` is this platform's `Mod`.
 * @returns Whether a handler took the key.
 */
function pressInEditor(body: Body, key: string, mods: { mod?: boolean; ctrl?: boolean; shift?: boolean }): boolean {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: mods.mod === true && MOD_IS_META,
    ctrlKey: mods.ctrl === true || (mods.mod === true && !MOD_IS_META),
    shiftKey: mods.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  let taken = false;
  act(() => {
    taken = body.view.someProp('handleKeyDown', (handler) => handler(body.view, event)) ?? false;
  });
  return taken;
}

/**
 * The body's blocks; the handle types its editor with `never` schemas, so the
 * blocks are read through the shape the cases use.
 * @param body - The body.
 * @returns The top-level blocks.
 */
function docBlocks(body: Body): Array<{ id: string; content?: unknown }> {
  return body.handle.editor.document as unknown as Array<{ id: string; content?: unknown }>;
}

/**
 * Removes the second block (`second`) as one undoable step.
 * @param body - The body.
 */
function deleteSecond(body: Body): void {
  act(() => { body.handle.editor.removeBlocks([docBlocks(body)[1]!.id]); });
  body.handle.undoManager.stopCapturing();
  expect(blocks(body)).toEqual(['hello world']);
}

/**
 * Pushes a phase and clears the counters, so only what follows is counted.
 * @param body - The body.
 * @param fixture - The push.
 */
function enter(body: Body, fixture: typeof F_FULL): void {
  push(body.provider, fixture);
  undoSpy.mockClear();
  redoSpy.mockClear();
  vi.mocked(toast.warning).mockClear();
}

/** What a refused step must leave untouched. */
interface Snapshot {
  update: Uint8Array;
  fragment: string;
  pm: unknown;
  stacks: number[];
}

/**
 * Captures the document, the PM doc and the stack lengths.
 * @param body - The body.
 * @returns The snapshot.
 */
function snapshot(body: Body): Snapshot {
  return {
    update: Y.encodeStateAsUpdate(body.doc),
    fragment: documentBodyFragment(body.doc).toString(),
    pm: body.view.state.doc.toJSON(),
    stacks: [body.handle.undoManager.undoStack.length, body.handle.undoManager.redoStack.length],
  };
}

/**
 * Asserts a refused undo or redo left everything as it was and said so once.
 * @param body - The body.
 * @param before - The snapshot taken before the step.
 */
function expectRefused(body: Body, before: Snapshot): void {
  expect(snapshot(body)).toEqual(before);
  expect(toast.warning).toHaveBeenCalledTimes(1);
  expect(toast.warning).toHaveBeenCalledWith(COPY_EN.T_ADD_BLOCKED);
  expect(toast.error).not.toHaveBeenCalled();
}

beforeEach(() => {
  changeLocale('en');
  undoSpy = vi.spyOn(Y.UndoManager.prototype, 'undo');
  redoSpy = vi.spyOn(Y.UndoManager.prototype, 'redo');
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  detachers.splice(0).forEach((detach) => { detach(); });
  cleanup();
  undoSpy.mockRestore();
  redoSpy.mockRestore();
  _resetDocumentEditorCacheForTests();
  containers.splice(0).forEach((container) => { container.remove(); });
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
});

describe('W-115 document body undo and redo under F_FULL', () => {
  it('(a) Mod-z inside the editor does not bring a deleted paragraph back', () => {
    const body = openBody();
    deleteSecond(body);
    enter(body, F_FULL);
    const before = snapshot(body);

    pressInEditor(body, 'z', { mod: true });

    expect(blocks(body)).toEqual(['hello world']);
    expect(undoSpy).not.toHaveBeenCalled();
    expectRefused(body, before);
  });

  it.each([
    ['Cmd+Z', { meta: true }],
    ['Ctrl+Z', { ctrl: true }],
  ] as const)('(b) %s on the focused scroller does not bring a deleted paragraph back', (_label, mods) => {
    const body = openBody();
    const scroller = document.createElement('div');
    containers[0]!.appendChild(scroller);
    detachers.push(attachBodyScroller(body.view, scroller, body.handle.editor));
    deleteSecond(body);
    enter(body, F_FULL);
    const before = snapshot(body);

    act(() => {
      scroller.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'z',
        metaKey: 'meta' in mods,
        ctrlKey: 'ctrl' in mods,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(blocks(body)).toEqual(['hello world']);
    expect(undoSpy).not.toHaveBeenCalled();
    expectRefused(body, before);
  });

  it('(c) Mod-z takes typed text back (a delete runs)', () => {
    const body = openBody();
    act(() => {
      const { state } = body.view;
      let end = 0;
      state.doc.descendants((n, pos) => {
        if (n.isText && n.text === 'hello world') end = pos + n.nodeSize;
        return true;
      });
      body.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)).insertText('abc'));
    });
    body.handle.undoManager.stopCapturing();
    expect(blocks(body)).toEqual(['hello worldabc', 'second']);
    enter(body, F_FULL);

    pressInEditor(body, 'z', { mod: true });

    expect(blocks(body)).toEqual(['hello world', 'second']);
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('(d) Ctrl+Y does not redo an undone paragraph insertion', () => {
    const body = openBody();
    act(() => {
      body.handle.editor.insertBlocks(
        [{ type: 'paragraph', content: 'third' } as never],
        body.handle.editor.document[1]!,
        'after',
      );
    });
    body.handle.undoManager.stopCapturing();
    expect(blocks(body)).toEqual(['hello world', 'second', 'third']);
    act(() => { body.handle.editor.undo(); });
    expect(blocks(body)).toEqual(['hello world', 'second']);
    enter(body, F_FULL);
    const before = snapshot(body);

    // Ctrl+Y is the Windows redo; jsdom's Mod is Ctrl, so `Mod-y` is it here.
    pressInEditor(body, 'y', { ctrl: true });

    expect(blocks(body)).toEqual(['hello world', 'second']);
    expect(redoSpy).not.toHaveBeenCalled();
    expectRefused(body, before);
  });

  it('(e) Shift+Mod-z redoes an undone paragraph deletion (a delete runs)', () => {
    const body = openBody();
    deleteSecond(body);
    act(() => { body.handle.editor.undo(); });
    expect(blocks(body)).toEqual(['hello world', 'second']);
    enter(body, F_FULL);

    pressInEditor(body, 'z', { mod: true, shift: true });

    expect(blocks(body)).toEqual(['hello world']);
    expect(redoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
