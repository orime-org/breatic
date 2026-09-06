// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 C1: Tab indents whatever block the caret is in.
 *
 * The rule the user settled on (§3.3) is that how far a block is indented has
 * nothing to do with what kind of block it is: Tab moves it one level in,
 * Shift-Tab moves it one level out, and changing a block's type leaves its
 * indentation where it was.
 *
 * Every case here dispatches the key rather than calling an API. `nestBlock()`
 * succeeds on a code block, while the key itself is claimed by the code
 * block's own handler and inserts two spaces — so a test written against the
 * API would pass while the user's Tab did something else entirely.
 *
 * Both shapes a selection comes in are covered: a caret, and a range. A range
 * is the one that was missing, and every path through Tab reached the browser
 * under one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

import { textblocks } from './textblocks';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly ReadBlock[];
}

/**
 * Opens an editor holding a plain first block and the block under test.
 * @param second - The block to put second, which is the one Tab acts on.
 * @returns The editor.
 */
function open(
  second: Readonly<Record<string, unknown>>,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'first' },
    second,
  ] as never);
  return editor;
}

/** The document as plain records. */
function blocksOf(editor: ReturnType<typeof buildDocumentEditor>): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

/**
 * Presses Tab, or Shift-Tab, through the keymap.
 * @param editor - The editor to press it in.
 * @param withShift - Whether Shift is held.
 * @returns Whether a handler claimed the key.
 */
function pressTab(
  editor: ReturnType<typeof buildDocumentEditor>,
  withShift = false,
): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: withShift,
    bubbles: true,
  });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

/** The eight things the block-type menu offers, as blocks. */
const EIGHT = [
  { label: 'a paragraph', block: { type: 'paragraph', content: 'x' } },
  {
    label: 'a level-one heading',
    block: { type: 'heading', props: { level: 1 }, content: 'x' },
  },
  {
    label: 'a level-two heading',
    block: { type: 'heading', props: { level: 2 }, content: 'x' },
  },
  {
    label: 'a level-three heading',
    block: { type: 'heading', props: { level: 3 }, content: 'x' },
  },
  { label: 'a bullet item', block: { type: 'bulletListItem', content: 'x' } },
  {
    label: 'an ordered item',
    block: { type: 'numberedListItem', content: 'x' },
  },
  { label: 'a to-do item', block: { type: 'checkListItem', content: 'x' } },
  {
    label: 'a quoted paragraph',
    block: { type: 'paragraph', props: { quoted: true }, content: 'x' },
  },
] as const;

/**
 * Opens an editor holding one block, with the caret in it.
 * @param block - The block to put in it.
 * @returns The editor.
 */
function openFirst(
  block: Record<string, unknown>,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);
  editor.setTextCursorPosition(blocksOf(editor)[0]!.id, 'end');
  return editor;
}

describe('Tab indents the block the caret is in', () => {
  EIGHT.forEach(({ label, block }) => {
    it(`moves ${label} under the block above it`, () => {
      const editor = open(block);
      editor.setTextCursorPosition(blocksOf(editor)[1]!.id, 'end');
      expect(pressTab(editor)).toBe(true);

      const top = blocksOf(editor);
      expect(top).toHaveLength(1);
      expect(top[0]?.children).toHaveLength(1);
      expect(top[0]?.children[0]?.type).toBe(block.type);
    });
  });

  it('holds the key even where there is nothing to indent under', () => {
    // BlockNote's own handler returns false when the block is first at its
    // level, and a Tab it does not claim is a Tab the browser answers:
    // measured in a browser, focus moved from the editor to `BODY` and the
    // next five characters the reader typed reached nothing.
    const editor = openFirst({ type: 'paragraph', content: 'the only block' });

    expect(pressTab(editor)).toBe(true);

    // Still one block, still at the top level: refusing to indent is right,
    // and holding the key is what keeps the caret where the reader left it.
    expect(blocksOf(editor)).toHaveLength(1);
    expect(blocksOf(editor)[0]?.children).toHaveLength(0);
  });

  it('moves a code block under the block above it, rather than typing spaces', () => {
    // Its own Tab handler indents the line inside the block, which is right
    // for a code editor and wrong here: this Space says Tab moves the block.
    const editor = open({ type: 'codeBlock', content: 'code' });
    editor.setTextCursorPosition(blocksOf(editor)[1]!.id, 'end');
    expect(pressTab(editor)).toBe(true);

    const top = blocksOf(editor);
    expect(top).toHaveLength(1);
    expect(top[0]?.children[0]?.type).toBe('codeBlock');
    // The text is untouched, read word for word: its own handler types two
    // spaces AT THE CARET, which sits at the end here, so a case looking for
    // them at the front would pass either way.
    expect(JSON.stringify(top[0]?.children[0])).toContain('"text":"code"');
  });
});

describe('Shift-Tab takes it back out', () => {
  it('returns an indented block to the top level', () => {
    const editor = open({ type: 'paragraph', content: 'x' });
    editor.setTextCursorPosition(blocksOf(editor)[1]!.id, 'end');
    pressTab(editor);
    expect(blocksOf(editor)).toHaveLength(1);

    expect(pressTab(editor, true)).toBe(true);
    expect(blocksOf(editor)).toHaveLength(2);
  });
});

describe('a quote keeps its quote through indenting', () => {
  it('stays quoted after Tab and after Shift-Tab', () => {
    const editor = open({
      type: 'paragraph',
      props: { quoted: true },
      content: 'x',
    });
    editor.setTextCursorPosition(blocksOf(editor)[1]!.id, 'end');
    pressTab(editor);
    expect(blocksOf(editor)[0]?.children[0]?.props['quoted']).toBe(true);

    pressTab(editor, true);
    expect(blocksOf(editor)[1]?.props['quoted']).toBe(true);
  });
});

/**
 * Selects a range inside a block rather than putting a caret in it.
 * @param editor - The editor.
 * @param index - Which textblock, in document order.
 * @param reversed - Whether the head sits before the anchor.
 */
function selectInside(
  editor: ReturnType<typeof buildDocumentEditor>,
  index: number,
  reversed = false,
): void {
  const view = editor.prosemirrorView!;
  const at = textblocks(view.state.doc)[index]!.before;
  view.dispatch(
    view.state.tr.setSelection(
      reversed
        ? TextSelection.create(view.state.doc, at + 2, at + 1)
        : TextSelection.create(view.state.doc, at + 1, at + 2),
    ),
  );
}

/**
 * Selects from inside one textblock to inside another.
 * @param editor - The editor.
 * @param first - The textblock the selection starts in, in document order.
 * @param last - The textblock it ends in.
 */
function selectAcross(
  editor: ReturnType<typeof buildDocumentEditor>,
  first: number,
  last: number,
): void {
  const view = editor.prosemirrorView!;
  const spots = textblocks(view.state.doc);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(
        view.state.doc,
        spots[first]!.before + 1,
        spots[last]!.before + 2,
      ),
    ),
  );
}

describe('C1 — Tab acts on a selection, not only on a caret', () => {
  it('indents the block a range sits in', () => {
    const editor = open({ type: 'paragraph', content: 'second' });
    selectInside(editor, 1);

    expect(pressTab(editor)).toBe(true);
    expect(blocksOf(editor)).toHaveLength(1);
    expect(blocksOf(editor)[0]?.children).toHaveLength(1);
  });

  it('indents it the same way when the range runs backwards', () => {
    const editor = open({ type: 'paragraph', content: 'second' });
    selectInside(editor, 1, true);

    expect(pressTab(editor)).toBe(true);
    expect(blocksOf(editor)[0]?.children).toHaveLength(1);
  });

  it('takes the indent back off under a range', () => {
    const editor = open({ type: 'paragraph', content: 'second' });
    selectInside(editor, 1);
    pressTab(editor);
    selectInside(editor, 1);

    expect(pressTab(editor, true)).toBe(true);
    expect(blocksOf(editor)).toHaveLength(2);
  });

  it('indents every block a selection spans', () => {
    const editor = openFirst({ type: 'paragraph', content: 'one' });
    editor.insertBlocks(
      [
        { type: 'paragraph', content: 'two' },
        { type: 'paragraph', content: 'three' },
      ] as never,
      blocksOf(editor)[0]!.id,
      'after',
    );
    // From the second block to the third: the first block stays above them,
    // so the range has somewhere to go.
    selectAcross(editor, 1, 2);

    expect(pressTab(editor)).toBe(true);
    expect(blocksOf(editor)).toHaveLength(1);
    expect(blocksOf(editor)[0]?.children).toHaveLength(2);
  });

  it('leaves a selection that starts at the first block where it is', () => {
    const editor = open({ type: 'paragraph', content: 'second' });
    selectAcross(editor, 0, 1);

    // Nowhere to go — the first block has no block above it. The key is still
    // claimed, because an unclaimed Tab takes focus out of the editor.
    expect(pressTab(editor)).toBe(true);
    expect(blocksOf(editor)).toHaveLength(2);
    expect(blocksOf(editor)[0]?.children).toHaveLength(0);
  });
});
