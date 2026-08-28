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
import {
  BLOCK_TYPE_ITEMS,
  holdsFallbackContent,
} from '@web/spaces/document/document-block-type';
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

/**
 * A paragraph reading "before" carrying a fallback inline node after "be".
 * @returns The editor.
 */
function withFallbackInline(): Editor {
  const editor = open('<p>before</p>');
  const node = editor.state.schema.nodes.unsupportedInline.create({
    name: 'somethingNewer',
    json: '{}',
  });
  editor.view.dispatch(editor.state.tr.insert(3, node));
  return editor;
}

/**
 * A paragraph whose text carries a fallback mark.
 * @returns The editor.
 */
function withFallbackMark(): Editor {
  const editor = open('<p>before</p>');
  const mark = editor.state.schema.marks.unsupportedMark.create({
    name: 'somethingNewer',
    json: '{}',
  });
  editor.view.dispatch(editor.state.tr.addMark(1, 4, mark));
  return editor;
}

/** Does the document still hold a fallback inline node? */
const stillHasFallbackInline = (editor: Editor): boolean => {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'unsupportedInline') found = true;
    return !found;
  });
  return found;
};

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

describe('the guard on the code block row', () => {
  it.each([
    ['the whole paragraph', (e: Editor) => contentOf(e, 'paragraph')],
    ['only the text ahead of the fallback', () => ({ from: 1, to: 3 })],
    ['only the text after it', () => ({ from: 6, to: 9 })],
  ])('refuses where a fallback inline node shares the block: %s', (_name, pick) => {
    const editor = withFallbackInline();
    editor.commands.setTextSelection(pick(editor));
    expect(row('code-block').canRun?.(editor)).toBe(false);
  });

  it('refuses where the block sits inside a list item', () => {
    const editor = open('<ul><li><p>item</p></li></ul>');
    const node = editor.state.schema.nodes.unsupportedInline.create({
      name: 'somethingNewer',
      json: '{}',
    });
    editor.view.dispatch(editor.state.tr.insert(4, node));
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    expect(row('code-block').canRun?.(editor)).toBe(false);
  });

  it('refuses where only one of two selected blocks holds one', () => {
    const editor = withFallbackInline();
    editor.view.dispatch(
      editor.state.tr.insert(
        editor.state.doc.content.size,
        editor.state.schema.nodes.paragraph.create(
          null,
          editor.state.schema.text('after'),
        ),
      ),
    );
    editor.commands.setTextSelection({
      from: 1,
      to: editor.state.doc.content.size - 1,
    });
    expect(row('code-block').canRun?.(editor)).toBe(false);
  });

  it('refuses where the text carries a fallback mark', () => {
    const editor = withFallbackMark();
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    expect(row('code-block').canRun?.(editor)).toBe(false);
  });

  it('allows a block with nothing of the sort in it', () => {
    const editor = open('<p>plain text</p>');
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    expect(row('code-block').canRun?.(editor)).toBe(true);
  });

  it('guards against a real deletion, not an imagined one', () => {
    // The guard says no above. Run the command anyway and the fallback goes —
    // which is what the guard is standing in front of.
    const editor = withFallbackInline();
    editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
    expect(stillHasFallbackInline(editor)).toBe(true);
    editor.chain().focus().toggleCodeBlock().run();
    expect(stillHasFallbackInline(editor)).toBe(false);
  });

  it('reads the blocks the command rewrites, not the selection', () => {
    const editor = withFallbackInline();
    // A selection covering neither side of the fallback node still sits in the
    // block that holds it.
    editor.commands.setTextSelection({ from: 6, to: 9 });
    expect(holdsFallbackContent(editor)).toBe(true);
  });
});

describe('the other four rows', () => {
  it.each([['paragraph'], ['heading-1'], ['heading-2'], ['heading-3']])(
    '%s carries no guard',
    (id) => {
      expect(row(id as BlockTypeId).canRun).toBeUndefined();
    },
  );

  it.each([['paragraph'], ['heading-1'], ['heading-2'], ['heading-3']])(
    '%s leaves a fallback inline node where it was',
    (id) => {
      const editor = withFallbackInline();
      editor.commands.setTextSelection(contentOf(editor, 'paragraph'));
      press(id as BlockTypeId, editor);
      expect(stillHasFallbackInline(editor)).toBe(true);
    },
  );
});
