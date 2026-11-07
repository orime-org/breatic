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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Editor, type Extensions } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

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
import {
  enterSize,
  kindOf,
  spyOnSteps,
  trialKind,
  trialRan,
  type StepSpies,
} from '@web/data/yjs/__tests__/helpers/history-fork-harness';
import { P_FULL } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = docName.canvasSpace(PID, SID);

type Kind = 'text node body' | 'prompt' | 'lyrics';

let spies: StepSpies;
const editors: Editor[] = [];

/**
 * Builds node `n1` with a body, a prompt and lyrics (each one paragraph
 * `hello`) in a second replica and delivers it to the Space document as a
 * remote update.
 * @param doc - The Space document.
 */
function loadNode(doc: Y.Doc): void {
  const source = new Y.Doc();
  Y.applyUpdate(source, Y.encodeStateAsUpdate(doc));
  /**
   * A fragment holding one paragraph `hello`.
   * @returns The fragment, not attached yet.
   */
  const hello = (): Y.XmlFragment => {
    const fragment = new Y.XmlFragment();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('hello')]);
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
 * document as a remote update; the editor then types ` world`.
 * @param kind - Which editor.
 * @returns The editor.
 */
function typedEditor(kind: Kind): Open {
  const doc = getDoc(NAME);
  loadNode(doc);
  const fragment = fragmentOf(doc, kind);
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: extensionsFor(kind, fragment) });
  editors.push(editor);
  const manager = (yUndoPluginKey.getState(editor.state) as { undoManager: Y.UndoManager }).undoManager;
  manager.clear();
  expect(editor.state.doc.textContent).toBe('hello');
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
