// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec H-13:
 * the canvas TipTap editors (a text node's body, a generation prompt, the
 * lyrics) judge undo on a copy of the document whose scope is a fragment
 * nested inside a canvas node, not a root type.
 *
 * The fragments sit where the canvas keeps them (`data.body`,
 * `data.prompts.<mode>`, `data.lyrics.<mode>`) and their content arrives as a
 * remote update before the editor types (spec 0.1). The copy finds the nested
 * fragment by its item id (design 5.2); a trial that failed to find it would
 * refuse the step, so a full Space letting the undo through is what shows the
 * nested scope was resolved.
 *
 * It also covers the TipTap part of H-19 (`editor.commands.undo()` runs
 * `runHistoryStep`; over the ceiling the same case says T_OVER), HC-03 (an
 * empty stack is not tried) and HC-09 (each undo manager reuses its own last
 * conclusion: three refused TipTap undos copy the canvas document once, the
 * canvas manager's own refused undo once more). A copy is counted as an
 * `encodeStateAsUpdate` of the document, `yjs` mocked passing through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Editor, type Extensions } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';
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

import { toast } from '@web/lib/toast';
import { changeLocale } from '@web/i18n/locale-bootstrap';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { buildCollabExtensions } from '@web/features/collab-editor/collab-extensions';
import { yUndoPluginKey } from '@web/features/collab-editor/collab-plugin-keys';
import { buildTextNodeExtensions } from '@web/spaces/canvas/nodes/TextNodeEditor';
import { runHistoryStep } from '@web/data/yjs/history-step';
import { addNode, getCanvasUndoManager, removeNode, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import {
  copiesOf,
  enterSize,
  gatedStep,
  kindOf,
  localUpdate,
  resetCopies,
  spyOnSteps,
  trialKind,
  trialRan,
  type StepSpies,
} from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { COPY_V2_EN, P_FULL, P_OVER, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = docName.canvasSpace(PID, SID);

type Kind = 'text node body' | 'prompt' | 'lyrics';

let spies: StepSpies;
const editors: Editor[] = [];

/**
 * Builds node `n1` with a body, a prompt and lyrics (each one paragraph
 * `hello`, or the given text) in a second replica and delivers it to the
 * Space document as a remote update.
 * @param doc - The Space document.
 * @param content - Each paragraph's text.
 */
function loadNode(doc: Y.Doc, content = 'hello'): void {
  const source = new Y.Doc();
  Y.applyUpdate(source, Y.encodeStateAsUpdate(doc));
  /**
   * A fragment holding one paragraph `hello`.
   * @returns The fragment, not attached yet.
   */
  const hello = (): Y.XmlFragment => {
    const fragment = new Y.XmlFragment();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(content)]);
    fragment.insert(0, [paragraph]);
    return fragment;
  };
  source.transact(() => {
    const node = new Y.Map<unknown>();
    const data = new Y.Map<unknown>();
    const prompts = new Y.Map<unknown>();
    const lyrics = new Y.Map<unknown>();
    source.getMap<unknown>('nodesMap').set('n1', node);
    node.set('id', 'n1');
    node.set('type', 'text');
    node.set('data', data);
    data.set('body', hello());
    data.set('prompts', prompts);
    prompts.set('t2i', hello());
    data.set('lyrics', lyrics);
    lyrics.set('song', hello());
  });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source, Y.encodeStateVector(doc)), 'remote');
}

/**
 * The fragment one editor binds to.
 * @param doc - The Space document.
 * @param kind - Which editor.
 * @returns The nested fragment.
 */
function fragmentOf(doc: Y.Doc, kind: Kind): Y.XmlFragment {
  const data = (doc.getMap<Y.Map<unknown>>('nodesMap').get('n1')!).get('data') as Y.Map<unknown>;
  if (kind === 'text node body') return data.get('body') as Y.XmlFragment;
  const byMode = data.get(kind === 'prompt' ? 'prompts' : 'lyrics') as Y.Map<unknown>;
  return byMode.get(kind === 'prompt' ? 't2i' : 'song') as Y.XmlFragment;
}

/**
 * The extension list for one of the editors.
 * @param kind - Which editor.
 * @param fragment - The fragment it edits.
 * @returns The extensions.
 */
function extensionsFor(kind: Kind, fragment: Y.XmlFragment): Extensions {
  if (kind === 'text node body') {
    return buildTextNodeExtensions({ fragment, docName: NAME, placeholder: '' } as never);
  }
  // The prompt and lyrics editors compose their lists inline; this is the
  // same collaboration half over the same plain-text schema.
  return [Document, Paragraph, Text, ...buildCollabExtensions({ fragment, docName: NAME } as never)];
}

/** An open editor and what the case compares. */
interface Open {
  editor: Editor;
  doc: Y.Doc;
  manager: Y.UndoManager;
}

/**
 * Mounts an editor on the fragment first, then loads the node into the
 * document as a remote update, with empty undo stacks.
 * @param kind - Which editor.
 * @param content - The paragraph's text.
 * @returns The editor.
 */
function mountedEditor(kind: Kind, content = 'hello'): Open {
  const doc = getDoc(NAME);
  loadNode(doc, content);
  const fragment = fragmentOf(doc, kind);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: extensionsFor(kind, fragment) });
  editors.push(editor);
  const manager = (yUndoPluginKey.getState(editor.state) as { undoManager: Y.UndoManager }).undoManager;
  manager.clear();
  expect(editor.state.doc.textContent).toBe(content);
  return { editor, doc, manager };
}

/**
 * Deletes a range in the editor as its own undo step.
 * @param open - The editor.
 * @param from - Start.
 * @param to - End.
 */
function deleteRange(open: Open, from: number, to: number): void {
  act(() => {
    const { view } = open.editor;
    view.dispatch(view.state.tr.delete(from, to));
  });
  open.manager.stopCapturing();
}

/**
 * Mounts an editor on the fragment first, then loads the node into the
 * document as a remote update; the editor then types ` world`.
 * @param kind - Which editor.
 * @returns The editor.
 */
function typedEditor(kind: Kind): Open {
  const { editor, doc, manager } = mountedEditor(kind);
  act(() => {
    const { view } = editor;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)).insertText(' world'));
  });
  manager.stopCapturing();
  expect(editor.state.doc.textContent).toBe('hello world');
  return { editor, doc, manager };
}

beforeEach(() => {
  changeLocale('en');
  spies = spyOnSteps();
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  editors.splice(0).forEach((editor) => { editor.destroy(); });
  cleanup();
  spies.restore();
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  _resetForTests();
});

describe.each<Kind>(['text node body', 'prompt', 'lyrics'])('H-13 %s editor', (kind) => {
  it('H-13 when full the trial over the nested fragment is a delete, not a refusal', () => {
    const open = typedEditor(kind);
    enterSize(NAME, P_FULL);

    expect(trialKind(open.manager, 'undo')).toBe('delete');
  });

  it('H-13 when full editor.commands.undo() takes the typed text back, judged on a copy, without a toast', () => {
    const open = typedEditor(kind);
    enterSize(NAME, P_FULL);
    spies.undo.mockClear();
    vi.mocked(toast.warning).mockClear();

    const written = kindOf(open.doc, () => { act(() => { open.editor.commands.undo(); }); });

    expect(written).toBe('delete');
    expect(open.editor.state.doc.textContent).toBe('hello');
    expect(trialRan(spies, open.doc)).toBe(true);
    expect(spies.undo.mock.contexts).toContain(open.manager);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe.each<Kind>(['text node body', 'prompt', 'lyrics'])('H-19 (round 6) %s editor undo runs runHistoryStep', (kind) => {
  it.each([
    ['full', P_FULL, COPY_V2_EN.T_ADD],
    ['over the ceiling', P_OVER, COPY_V2_EN.T_OVER],
  ] as const)('H-19 undoing a text deletion %s: runHistoryStep once, refused with its toast, the stack stays', (_label, fixture, sentence) => {
    const open = mountedEditor(kind, 'hello world');
    deleteRange(open, 7, 12);
    expect(open.editor.state.doc.textContent).toBe('hello ');
    enterSize(NAME, fixture);
    vi.mocked(toast.warning).mockClear();
    vi.mocked(runHistoryStep).mockClear();
    const before = Y.encodeStateAsUpdate(open.doc);
    const lengths = [open.manager.undoStack.length, open.manager.redoStack.length];

    const update = localUpdate(open.doc, () => { act(() => { open.editor.commands.undo(); }); });

    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runHistoryStep)).toHaveBeenCalledWith(NAME, open.manager, 'undo');
    expect(update).toBeNull();
    expect(Y.encodeStateAsUpdate(open.doc)).toEqual(before);
    expect([open.manager.undoStack.length, open.manager.redoStack.length]).toEqual(lengths);
    expect(open.editor.state.doc.textContent).toBe('hello ');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(sentence);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('HC-03 a canvas text node editor undo on an empty stack when full', () => {
  it('HC-03 editor.commands.undo() with nothing to undo: no copy, nothing written, no toast', () => {
    const open = mountedEditor('text node body');
    enterSize(NAME, P_FULL);
    vi.mocked(toast.warning).mockClear();
    resetCopies();

    const update = localUpdate(open.doc, () => { act(() => { open.editor.commands.undo(); }); });

    expect(copiesOf(open.doc)).toBe(0);
    expect(update).toBeNull();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

/**
 * Wire fields of a canvas node.
 * @param id - Node id.
 * @returns The node.
 */
function canvasNode(id: string): CanvasNodeFields {
  return {
    id,
    type: 'text',
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields;
}

describe('HC-09 each undo manager keeps its own conclusion', () => {
  it('HC-09 three refused text node undos copy the canvas document once; the canvas manager\'s refused undo copies once more', () => {
    const open = mountedEditor('text node body', 'hello world');
    const canvas = getCanvasUndoManager(open.doc, NAME);
    canvas.clear();
    act(() => { addNode(PID, SID, canvasNode('n9')); });
    canvas.stopCapturing();
    act(() => { removeNode(PID, SID, 'n9'); });
    canvas.stopCapturing();
    enterSize(NAME, P_WARNING);
    deleteRange(open, 4, 6);
    expect(open.editor.state.doc.textContent).toBe('hel world');
    enterSize(NAME, P_FULL);
    vi.mocked(toast.warning).mockClear();
    resetCopies();

    for (let i = 0; i < 3; i += 1) act(() => { open.editor.commands.undo(); });

    expect(open.editor.state.doc.textContent).toBe('hel world');
    expect(toast.warning).toHaveBeenCalledTimes(3);
    expect(copiesOf(open.doc)).toBe(1);

    expect(gatedStep(NAME, canvas, 'undo')).toEqual({ ok: false, reason: 'full' });
    expect(copiesOf(open.doc)).toBe(2);
  });
});
