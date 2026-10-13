// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 design §5.7: before the browser moves the caret sideways,
 * prosemirror-view steps it past uneditable elements next to it
 * (`skipIgnoredNodes`). Since 1.42.4 any `contenteditable=false` element
 * counts, so at the start of a block whose node view draws something
 * uneditable before its content — a check list item's checkbox — the caret
 * was moved out of the content to before that box, and the browser's own
 * move then went one character too far. The patched view stops at the
 * content element of a block node; inside inline content it still steps past
 * what a node or mark view draws there.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Schema, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const views: EditorView[] = [];
const editors: Array<ReturnType<typeof buildDocumentEditor>> = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  for (const editor of editors.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    check: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
  marks: { tagged: {} },
});

/**
 * An uneditable element, the way a node or mark view draws its own parts.
 * @param text - What it shows.
 * @returns The element.
 */
function chrome(text: string): HTMLElement {
  const el = document.createElement('span');
  el.contentEditable = 'false';
  el.textContent = text;
  return el;
}

/**
 * A view whose `check` blocks draw a box before and a badge after their
 * content, and whose `tagged` marks draw an icon before theirs.
 * @param doc - The document.
 * @returns The view.
 */
function open(doc: PMNode): EditorView {
  const place = document.createElement('div');
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({ doc }),
    nodeViews: {
      check: () => {
        const dom = document.createElement('div');
        const contentDOM = document.createElement('p');
        dom.append(chrome('[ ]'), contentDOM, chrome('!'));
        return { dom, contentDOM };
      },
    },
    markViews: {
      tagged: () => {
        const dom = document.createElement('span');
        const contentDOM = document.createElement('span');
        dom.append(chrome('#'), contentDOM);
        return { dom, contentDOM };
      },
    },
  });
  views.push(view);
  return view;
}

/**
 * Puts the page caret on a text node and presses an arrow key at the view.
 * @param view - The view.
 * @param text - The text node.
 * @param offset - Where in it.
 * @param key - Which arrow.
 * @returns Where the page caret is after prosemirror-view's handling.
 */
function press(view: EditorView, text: Node, offset: number, key: 'ArrowLeft' | 'ArrowRight'): { node: Node | null; offset: number } {
  const selection = document.getSelection()!;
  selection.collapse(text, offset);
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { value: key === 'ArrowLeft' ? 37 : 39 });
  view.dom.dispatchEvent(event);
  return { node: selection.focusNode, offset: selection.focusOffset };
}

/**
 * The text node holding these words.
 * @param root - Where to look.
 * @param words - The words.
 * @returns The node.
 * @throws {Error} When there is none.
 */
function textNode(root: Node, words: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (n.textContent === words) return n as Text;
  }
  throw new Error(`no text "${words}"`);
}

describe('skipping uneditable elements before a sideways caret move (patched prosemirror-view)', () => {
  it('keeps the caret in a block content element that a box stands before', () => {
    const view = open(schema.node('doc', null, [schema.node('paragraph', null, schema.text('above')), schema.node('check', null, schema.text('task'))]));
    const content = textNode(view.dom, 'task').parentElement!;
    const at = press(view, textNode(view.dom, 'task'), 0, 'ArrowLeft');
    expect(content.contains(at.node), `${at.node?.nodeName}@${at.offset}`).toBe(true);
  });

  it('keeps the caret in a block content element that a badge stands after', () => {
    const view = open(schema.node('doc', null, [schema.node('check', null, schema.text('task')), schema.node('paragraph', null, schema.text('below'))]));
    const content = textNode(view.dom, 'task').parentElement!;
    const at = press(view, textNode(view.dom, 'task'), 4, 'ArrowRight');
    expect(content.contains(at.node)).toBe(true);
  });

  it('still steps past what a mark view draws before its text inside a line', () => {
    const tagged = schema.marks['tagged'].create();
    const view = open(schema.node('doc', null, [schema.node('paragraph', null, [schema.text('ab'), schema.text('cd', [tagged])])]));
    const icon = textNode(view.dom, '#').parentElement!;
    const markContent = textNode(view.dom, 'cd').parentElement!;
    const at = press(view, textNode(view.dom, 'cd'), 0, 'ArrowLeft');
    // Left of the icon: neither in the marked text nor in the icon.
    expect([markContent.contains(at.node), icon.contains(at.node)]).toEqual([false, false]);
  });

  it('keeps the caret in a check list item of the document body, left of its first character', () => {
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    editor.mount(host);
    editors.push(editor);
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'before todo' },
      { type: 'checkListItem', content: 'todo text' },
    ] as never);
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(1))));
    const text = textNode(view.dom, 'todo text');
    const at = press(view, text, 0, 'ArrowLeft');
    expect(text.parentElement!.closest('.bn-inline-content')!.contains(at.node)).toBe(true);
  });
});
