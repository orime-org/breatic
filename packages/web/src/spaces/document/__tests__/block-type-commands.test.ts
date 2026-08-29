// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the five block type rows do to the document.
 *
 * The rows themselves — which one is marked, what the slot's face shows, when
 * a row is greyed — are pinned in `selection-bubble-shell.test.tsx`. Here is
 * only the outcome of running a row's command against a real schema.
 *
 * Every selection below is a range. The bar refuses a collapsed one
 * (`SelectionBubbleBar.tsx`'s `isWarranted`), so a caret case would describe a
 * state no reader can reach through this menu.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';
import { BLOCK_TYPE_ITEMS } from '@web/spaces/document/document-block-type';
import type { BlockTypeId } from '@web/spaces/document/document-block-type';

const live: Editor[] = [];

afterEach(() => {
  live.splice(0).forEach((e) => {
    e.destroy();
  });
  vi.restoreAllMocks();
});

/**
 * An editor holding the given body, on a Y.Doc of its own.
 * @param bodyHtml - The body's HTML.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  live.push(editor);
  editor.commands.setContent(bodyHtml);
  return editor;
}

/**
 * The row with this id.
 * @param id - Which row.
 * @returns The row.
 */
function row(id: BlockTypeId): (typeof BLOCK_TYPE_ITEMS)[number] {
  const found = BLOCK_TYPE_ITEMS.find((item) => item.id === id);
  if (!found) throw new Error(`no block type row ${id}`);
  return found;
}

/**
 * Presses a row, the way `onSelect` does.
 *
 * A row with no command is a failure here rather than a silent no-op: an
 * optional call would let every assertion below pass while nothing ran.
 * @param id - Which row.
 * @param editor - The editor to act on.
 */
function press(id: BlockTypeId, editor: Editor): void {
  const item = row(id);
  if (!item.run) throw new Error(`block type row ${id} reaches no command`);
  item.run(editor);
}

/**
 * The nth node of the given type, as a text range covering its content.
 * @param editor - The editor.
 * @param typeName - Node type to look for.
 * @param nth - Which one, zero based.
 * @returns The range.
 */
function contentOf(
  editor: Editor,
  typeName: string,
  nth = 0,
): { from: number; to: number } {
  const hits: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === typeName) {
      hits.push({ from: pos + 1, to: pos + node.nodeSize - 1 });
    }
    return true;
  });
  const hit = hits[nth];
  if (!hit) throw new Error(`no ${typeName} at index ${nth}`);
  return hit;
}


describe('the paragraph row', () => {
  it('leaves a plain paragraph reading the same', () => {
    const editor = open('<p>hello world</p>');
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    const before = editor.getHTML();
    press('paragraph', editor);
    expect(editor.getHTML()).toBe(before);
  });

  it('takes a quoted paragraph out of its quote', () => {
    const editor = open('<blockquote><p>quoted</p></blockquote>');
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    press('paragraph', editor);
    expect(editor.getHTML()).toBe('<p>quoted</p>');
  });

  it('turns a heading back into a paragraph', () => {
    const editor = open('<h2>a heading</h2>');
    editor.commands.setTextSelection(contentOf(editor, 'heading'));
    press('paragraph', editor);
    expect(editor.getHTML()).toBe('<p>a heading</p>');
  });
});

describe('the heading rows', () => {
  it.each([
    ['heading-1', '<h1>plain text</h1>'],
    ['heading-2', '<h2>plain text</h2>'],
    ['heading-3', '<h3>plain text</h3>'],
  ])('%s makes that level', (id, expected) => {
    const editor = open('<p>plain text</p>');
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    press(id as BlockTypeId, editor);
    expect(editor.getHTML()).toBe(expected);
  });

  it('goes back to a paragraph when the selection sits on that same level', () => {
    const editor = open('<h1>plain text</h1>');
    editor.commands.setTextSelection(contentOf(editor, 'heading'));
    press('heading-1', editor);
    expect(editor.getHTML()).toBe('<p>plain text</p>');
  });

  it('keeps the quote and makes a heading inside it', () => {
    const editor = open('<blockquote><p>quoted</p></blockquote>');
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    press('heading-1', editor);
    expect(editor.getHTML()).toBe('<blockquote><h1>quoted</h1></blockquote>');
  });
});

describe('the code block row', () => {
  it('makes a code block, and goes back on a second press', () => {
    const editor = open('<p>const x = 1</p>');
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    press('code-block', editor);
    expect(editor.getHTML()).toBe('<pre><code>const x = 1</code></pre>');

    editor.commands.setTextSelection(contentOf(editor, 'codeBlock'));
    press('code-block', editor);
    expect(editor.getHTML()).toBe('<p>const x = 1</p>');
  });
});

describe('all five rows', () => {
  it.each([['paragraph'], ['heading-1'], ['heading-2'], ['heading-3'], ['code-block']])(
    '%s carries no guard',
    (id) => {
      expect(row(id as BlockTypeId).canRun).toBeUndefined();
    },
  );
});
