// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// The reference chip plugins in an editor with no collaboration behind it:
// its undo is the plain history plugin and there is no Yjs document to
// anchor positions to. The chat box is such an editor.

import { afterEach, describe, it, expect } from 'vitest';
import { Editor, Extension, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { history, undo } from '@tiptap/pm/history';

import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/features/reference-mention/mention-node';
import {
  createReferenceMentionCaret,
  referenceMentionCaretKey,
} from '@web/features/reference-mention/reference-mention-caret';
import {
  createLocalUserInputTracker,
  wasLastChangeLocalUserInput,
} from '@web/features/reference-mention/reference-mention-local-input';

const Chip = Node.create({
  name: REFERENCE_MENTION_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { [MENTION_SOURCE_ID_ATTR]: { default: null } };
  },
  renderHTML() {
    return ['span', { 'data-reference-mention': '' }];
  },
  addProseMirrorPlugins() {
    return [createReferenceMentionCaret(), createLocalUserInputTracker()];
  },
});

const History = Extension.create({
  name: 'plainHistory',
  addProseMirrorPlugins() {
    return [history()];
  },
});

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/**
 * An editor with the chip plugins and plain history.
 * @returns The editor.
 */
function makeEditor(): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, History, Chip],
  });
  return editor;
}

/**
 * Calls the caret plugin's drop handler directly.
 * @param e - The editor.
 * @param moved - Whether the drop is a move.
 */
function drop(e: Editor, moved: boolean): void {
  const plugin = referenceMentionCaretKey.get(e.state);
  const fn = (plugin?.props as { handleDrop?: unknown } | undefined)?.handleDrop;
  if (typeof fn !== 'function') throw new Error('handleDrop prop missing');
  (fn as (v: unknown, ev: unknown, s: unknown, m: boolean) => boolean).call(plugin, e.view, {}, null, moved);
}

describe('reference chip plugins without collaboration', () => {
  it('does not read an undo as the user typing', () => {
    const e = makeEditor();
    e.chain().insertContent('hello').run();
    expect(wasLastChangeLocalUserInput(e)).toBe(true);

    undo(e.state, e.view.dispatch);

    expect(wasLastChangeLocalUserInput(e)).toBe(false);
  });

  it('restores the dragged selection on a moved drop after the selection drifted', () => {
    const e = makeEditor();
    e.chain().insertContent('hello world').run();
    e.commands.setTextSelection({ from: 2, to: 7 });
    e.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
    e.commands.setTextSelection({ from: 9, to: 9 });

    drop(e, true);

    expect(e.state.selection.from).toBe(2);
    expect(e.state.selection.to).toBe(7);
  });

  it('carries the dragged range through an edit made before the drop', () => {
    const e = makeEditor();
    e.chain().insertContent('hello world').run();
    e.commands.setTextSelection({ from: 2, to: 7 });
    e.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
    e.view.dispatch(e.state.tr.insertText('AB', 1));
    e.commands.setTextSelection({ from: 11, to: 11 });

    drop(e, true);

    expect(e.state.selection.from).toBe(4);
    expect(e.state.selection.to).toBe(9);
  });

  it('drags every chip in a selection after a press on one of them collapsed it', () => {
    const e = makeEditor();
    const chip = { type: REFERENCE_MENTION_NODE, attrs: { [MENTION_SOURCE_ID_ATTR]: 'a' } };
    e.chain().insertContent([chip, { type: 'text', text: 'x' }, chip]).run();
    const positions: number[] = [];
    e.state.doc.descendants((n, pos) => {
      if (n.type.name === REFERENCE_MENTION_NODE) positions.push(pos);
    });
    const from = positions[0];
    const to = positions[1] + 1;
    e.commands.setTextSelection({ from, to });
    const chipEl = e.view.dom.querySelector('[data-reference-mention]') as HTMLElement;

    chipEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    e.commands.setNodeSelection(from);
    chipEl.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));

    expect(e.state.selection.from).toBe(from);
    expect(e.state.selection.to).toBe(to);
  });
});
