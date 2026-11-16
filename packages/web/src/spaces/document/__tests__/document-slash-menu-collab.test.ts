// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The slash menu while a collaborator deletes the row it was opened on
 * (inner#1125 A9, design 5.7).
 *
 * The extension tracks where the query starts with BlockNote's position
 * tracking. The body's Y.Doc collects deleted content, and the tracker throws
 * once the position it holds is gone, so this pins that the remote delete
 * closes the menu and is applied.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SuggestionMenu } from '@blocknote/core/extensions';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { para } from '@web/spaces/document/__tests__/column-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

// The extension stores the anchor with `getBoundingClientRect().toJSON()`;
// jsdom's rect has no `toJSON`.
const rectDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');

beforeEach(() => {
  const original = Element.prototype.getBoundingClientRect;
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      const rect = original.call(this);
      return { ...rect, toJSON: () => ({}) };
    },
  });
});

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
  if (rectDescriptor) Object.defineProperty(Element.prototype, 'getBoundingClientRect', rectDescriptor);
});

function mount(doc: Y.Doc): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

function syncer(a: Y.Doc, b: Y.Doc): () => void {
  return () => {
    for (let round = 0; round < 5; round += 1) {
      const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      Y.applyUpdate(b, toB, 'peer');
      Y.applyUpdate(a, toA, 'peer');
    }
  };
}

function idOf(editor: Editor, words: string): string {
  let found: string | undefined;
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (found !== undefined) return false;
    if (node.type.name === 'blockContainer' && node.firstChild?.textContent === words) {
      found = String(node.attrs.id);
      return false;
    }
    return true;
  });
  if (found === undefined) throw new Error(`no block reads "${words}"`);
  return found;
}

/** Types one character at the caret the way a keystroke reaches ProseMirror. */
function typeAtCaret(editor: Editor, text: string): void {
  const view = editor.prosemirrorView;
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (f) =>
    f(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
  );
  if (handled !== true) view.dispatch(view.state.tr.insertText(text, from, to));
}

describe('the slash menu when a collaborator deletes its row', () => {
  it('closes the menu and applies the delete', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ours = mount(a);
    const theirs = mount(b);
    ours.replaceBlocks(ours.document, [para('first'), para('second')] as never);
    const sync = syncer(a, b);
    sync();

    const menu = ours.getExtension(SuggestionMenu);
    expect(menu).toBeDefined();
    menu?.addSuggestionMenu({ triggerCharacter: '/' });

    const second = idOf(ours, 'second');
    ours.setTextCursorPosition(second, 'end');
    const view = ours.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from)));
    typeAtCaret(ours, ' ');
    typeAtCaret(ours, '/');
    expect(menu?.store.state?.show).toBe(true);

    sync();
    theirs.removeBlocks([second]);
    expect(() => {
      sync();
    }).not.toThrow();
    expect((ours.document as unknown as { id: string }[]).map((block) => block.id)).not.toContain(second);
    expect(menu?.store.state?.show ?? false).toBe(false);
  });

  it('survives a delete of a row holding only the trigger, and a keystroke after it', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ours = mount(a);
    const theirs = mount(b);
    ours.replaceBlocks(ours.document, [para('first'), para('second'), para('third')] as never);
    const sync = syncer(a, b);
    sync();

    const menu = ours.getExtension(SuggestionMenu);
    menu?.addSuggestionMenu({ triggerCharacter: '/' });
    const second = idOf(ours, 'second');
    ours.updateBlock(second, { content: '' } as never);
    ours.setTextCursorPosition(second, 'start');
    typeAtCaret(ours, '/');
    typeAtCaret(ours, 'h');
    expect(menu?.store.state?.show).toBe(true);

    sync();
    theirs.removeBlocks([second]);
    sync();
    // Closed by the sync itself, before any local key reaches the menu.
    expect(menu?.store.state?.show ?? false).toBe(false);
    expect(() => {
      typeAtCaret(ours, 'x');
      sync();
    }).not.toThrow();
    expect((ours.document as unknown as { id: string }[]).map((block) => block.id)).not.toContain(second);
    expect(menu?.store.state?.show ?? false).toBe(false);
  });

  it('lets the body unmount once the row is gone', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const ours = mount(a);
    const theirs = mount(b);
    ours.replaceBlocks(ours.document, [para('first'), para('second'), para('third')] as never);
    const sync = syncer(a, b);
    sync();

    const menu = ours.getExtension(SuggestionMenu);
    menu?.addSuggestionMenu({ triggerCharacter: '/' });
    const second = idOf(ours, 'second');
    ours.updateBlock(second, { content: '' } as never);
    ours.setTextCursorPosition(second, 'start');
    typeAtCaret(ours, '/');

    sync();
    theirs.removeBlocks([second]);
    sync();
    expect(() => {
      mounted.splice(mounted.indexOf(ours), 1);
      ours.unmount();
    }).not.toThrow();
  });
});

describe('the slash menu when the caret goes into a code block', () => {
  it('closes on a press inside a code block', () => {
    const ours = mount(new Y.Doc());
    ours.replaceBlocks(ours.document, [para('first'), { type: 'codeBlock', content: 'let x' }, para('')] as never);
    const menu = ours.getExtension(SuggestionMenu);
    menu?.addSuggestionMenu({ triggerCharacter: '/' });
    const blocks = ours.document as unknown as { id: string }[];
    ours.setTextCursorPosition(blocks[2]!.id, 'start');
    typeAtCaret(ours, '/');
    expect(menu?.store.state?.show).toBe(true);

    ours.setTextCursorPosition(blocks[1]!.id, 'end');
    const view = ours.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from)).setMeta('pointer', true));
    expect(menu?.store.state?.show ?? false).toBe(false);
  });

  it('still does not open on a slash typed in a code block', () => {
    const ours = mount(new Y.Doc());
    ours.replaceBlocks(ours.document, [{ type: 'codeBlock', content: 'a ' }] as never);
    const menu = ours.getExtension(SuggestionMenu);
    menu?.addSuggestionMenu({ triggerCharacter: '/' });
    const blocks = ours.document as unknown as { id: string }[];
    ours.setTextCursorPosition(blocks[0]!.id, 'end');
    typeAtCaret(ours, '/');
    expect(menu?.store.state?.show ?? false).toBe(false);
  });
});
