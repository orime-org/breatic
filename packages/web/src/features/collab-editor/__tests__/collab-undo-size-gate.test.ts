// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 11, W-116: the TipTap editors on
 * the canvas (a text node's body and a generation prompt) judge undo and redo
 * at the command layer.
 *
 * The Collaboration extension's own `undo`/`redo` commands and its `Mod-z`,
 * `Shift-Mod-z` and `Mod-y` bindings call the y-tiptap undo manager directly,
 * so they are switched off and gated commands of the same names take their
 * place. Restoring deleted text is an `add` and is refused once the Space is
 * full; taking typed text back, and redoing a deletion, are `delete`s.
 *
 * How the editor learns its Space document's name is not fixed by the spec:
 * {@link buildEditor} passes it as a `docName` option to the builders (an
 * assumed name, the one place to change) and also builds the fragment inside
 * `getDoc(name)`, so an implementation reading the name off the fragment's
 * document works too.
 *
 * Keys go through `view.someProp('handleKeyDown')`. jsdom is not a Mac, so
 * `Mod` binds to Ctrl here; which modifier `Mod` is in this process is read
 * from the keymap rather than assumed.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Editor, type Extensions } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';
import { keydownHandler } from '@tiptap/pm/keymap';
import type { EditorView } from '@tiptap/pm/view';
import * as Y from 'yjs';
import { spaceContentDocName } from '@breatic/shared';

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
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { yUndoPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { buildTextNodeExtensions } from '@web/spaces/canvas/nodes/TextNodeEditor';
import { push, resetProviderSpies, type ProviderSpy } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { COPY_EN, F_FULL, F_NORMAL, F_WARNING } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = spaceContentDocName(PID, SID, 'canvas');

/** Whether this process's keymap reads `Mod` as Meta (a Mac platform) or Ctrl. */
const MOD_IS_META = keydownHandler({ 'Mod-z': () => true })(
  {} as EditorView,
  new KeyboardEvent('keydown', { key: 'z', metaKey: true }),
);

type Kind = 'text node' | 'prompt';

let undoSpy: MockInstance;
let redoSpy: MockInstance;
const editors: Editor[] = [];

/** An open editor over a canvas Space fragment. */
interface Open {
  editor: Editor;
  doc: Y.Doc;
  fragment: Y.XmlFragment;
  provider: ProviderSpy;
  manager: Y.UndoManager;
}

/**
 * The extension list for one of the two editors, given the Space document's
 * name. `docName` is the assumed option through which the name reaches the
 * size filter.
 * @param kind - Which editor.
 * @param fragment - The fragment it edits.
 * @returns The extensions.
 */
function extensionsFor(kind: Kind, fragment: Y.XmlFragment): Extensions {
  if (kind === 'text node') {
    return buildTextNodeExtensions({ fragment, docName: NAME, placeholder: '' } as never);
  }
  // The prompt editor composes its list inline in `PromptEditor`; this is the
  // same collaboration half over the same plain-text schema.
  return [Document, Paragraph, Text, ...buildCollabExtensions({ fragment, docName: NAME } as never)];
}

/**
 * Opens an editor on a fragment of the canvas document holding `hello world`,
 * after pushing `F_NORMAL`.
 * @param kind - Which editor.
 * @returns The editor and what the cases compare.
 * @throws {Error} When the editor cannot be built.
 */
function buildEditor(kind: Kind): Open {
  const doc = getDoc(NAME);
  const provider = acquireDocProvider(NAME, doc) as unknown as ProviderSpy;
  push(provider, F_NORMAL);
  const fragment = doc.getXmlFragment(kind === 'text node' ? 'probe-body' : 'probe-prompt');
  doc.transact(() => {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('hello world')]);
    fragment.insert(0, [paragraph]);
  });
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: extensionsFor(kind, fragment) });
  editors.push(editor);
  const manager = (yUndoPluginKey.getState(editor.state) as { undoManager: Y.UndoManager }).undoManager;
  manager.clear();
  return { editor, doc, fragment, provider, manager };
}

/**
 * Deletes `world` (positions 7 to 12) as one undoable step.
 * @param open - The editor.
 */
function deleteWorld(open: Open): void {
  act(() => {
    const { view } = open.editor;
    view.dispatch(view.state.tr.delete(7, 12));
  });
  open.manager.stopCapturing();
  expect(open.editor.state.doc.textContent).toBe('hello ');
}

/**
 * Types `abc` at the end of the line as one undoable step.
 * @param open - The editor.
 */
function typeAbc(open: Open): void {
  act(() => {
    const { view } = open.editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 12)).insertText('abc'));
  });
  open.manager.stopCapturing();
  expect(open.editor.state.doc.textContent).toBe('hello worldabc');
}

/**
 * Presses a key in the editor.
 * @param open - The editor.
 * @param key - `KeyboardEvent.key`.
 * @param mods - `mod` is this platform's `Mod`; `ctrl` is Ctrl itself.
 */
function press(open: Open, key: string, mods: { mod?: boolean; ctrl?: boolean; shift?: boolean }): void {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: mods.mod === true && MOD_IS_META,
    ctrlKey: mods.ctrl === true || (mods.mod === true && !MOD_IS_META),
    shiftKey: mods.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    open.editor.view.someProp('handleKeyDown', (handler) => handler(open.editor.view, event));
  });
}

/**
 * Pushes a phase and clears the counters.
 * @param open - The editor.
 * @param fixture - The push.
 */
function enter(open: Open, fixture: typeof F_FULL): void {
  push(open.provider, fixture);
  undoSpy.mockClear();
  redoSpy.mockClear();
  vi.mocked(toast.warning).mockClear();
}

/**
 * What a refused step must leave untouched.
 * @param open - The editor.
 * @returns The Yjs update, fragment text, PM text and stack lengths.
 */
function snapshot(open: Open): unknown[] {
  return [
    Y.encodeStateAsUpdate(open.doc),
    open.fragment.toString(),
    open.editor.state.doc.textContent,
    open.manager.undoStack.length,
    open.manager.redoStack.length,
  ];
}

/**
 * Asserts a refused step left everything alone and said so once.
 * @param open - The editor.
 * @param before - The snapshot taken before.
 */
function expectRefused(open: Open, before: unknown[]): void {
  expect(snapshot(open)).toEqual(before);
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
  editors.splice(0).forEach((editor) => { editor.destroy(); });
  cleanup();
  undoSpy.mockRestore();
  redoSpy.mockRestore();
  _resetCollabSocketForTests();
  _resetForTests();
  resetProviderSpies();
});

describe.each<Kind>(['text node', 'prompt'])('W-116 %s editor', (kind) => {
  it('(a) Mod-z does not bring deleted text back under F_FULL', () => {
    const open = buildEditor(kind);
    deleteWorld(open);
    enter(open, F_FULL);
    const before = snapshot(open);

    press(open, 'z', { mod: true });

    expect(open.editor.state.doc.textContent).toBe('hello ');
    expect(undoSpy).not.toHaveBeenCalled();
    expectRefused(open, before);
  });

  it('Mod-z in warning with less room than the deleted text needs is refused with the room left', () => {
    const open = buildEditor(kind);
    deleteWorld(open);
    enter(open, { ...F_WARNING, room: 1 });
    const before = snapshot(open);

    press(open, 'z', { mod: true });

    expect(open.editor.state.doc.textContent).toBe('hello ');
    expect(undoSpy).not.toHaveBeenCalled();
    expect(snapshot(open)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(COPY_EN.T_NO_ROOM('1 B'));
  });

  it('(b) Mod-z takes typed text back under F_FULL (a delete runs)', () => {
    const open = buildEditor(kind);
    typeAbc(open);
    enter(open, F_FULL);

    press(open, 'z', { mod: true });

    expect(open.editor.state.doc.textContent).toBe('hello world');
    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('(c) editor.commands.undo() does not bring deleted text back under F_FULL', () => {
    const open = buildEditor(kind);
    deleteWorld(open);
    enter(open, F_FULL);
    const before = snapshot(open);

    act(() => { open.editor.commands.undo(); });

    expect(open.editor.state.doc.textContent).toBe('hello ');
    expect(undoSpy).not.toHaveBeenCalled();
    expectRefused(open, before);
  });

  it.each([
    ['Ctrl+Y', 'y', { ctrl: true }],
    ['Ctrl+Shift+Z', 'z', { ctrl: true, shift: true }],
  ] as const)('(d) %s redoes a deletion under F_FULL (a delete runs)', (_label, key, mods) => {
    const open = buildEditor(kind);
    deleteWorld(open);
    act(() => { open.editor.commands.undo(); });
    expect(open.editor.state.doc.textContent).toBe('hello world');
    enter(open, F_FULL);

    press(open, key, mods);

    expect(open.editor.state.doc.textContent).toBe('hello ');
    expect(redoSpy).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  // The gated commands replace the extension's own: the redo command and both
  // redo bindings refuse to put typed text back once the Space is full.
  it.each([
    ['editor.commands.redo()', (open: Open): void => { act(() => { open.editor.commands.redo(); }); }],
    ['Mod-y', (open: Open): void => { press(open, 'y', { mod: true }); }],
    ['Shift-Mod-z', (open: Open): void => { press(open, 'z', { mod: true, shift: true }); }],
  ] as const)('redo through %s of undone typing is refused under F_FULL', (_label, redo) => {
    const open = buildEditor(kind);
    typeAbc(open);
    act(() => { open.editor.commands.undo(); });
    expect(open.editor.state.doc.textContent).toBe('hello world');
    enter(open, F_FULL);
    const before = snapshot(open);

    redo(open);

    expect(open.editor.state.doc.textContent).toBe('hello world');
    expect(redoSpy).not.toHaveBeenCalled();
    expectRefused(open, before);
  });
});
