// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904: the ordered list item this Space uses, and the three things its
 * built-in replacement had to keep doing.
 *
 * BlockNote ships `numberedListItem` with one extension carrying an input
 * rule, two keyboard shortcuts and an indexing plugin, and that plugin writes
 * the `data-index` attribute the built-in number is drawn from. This Space
 * draws numbers from its own decoration (§6.3), so two node decorations would
 * be writing the same attribute and the winner would come down to plugin
 * order. The block is rebuilt without it — which means the rest of that
 * extension has to be rebuilt too, and this is what holds it in place.
 *
 * The Enter handler is rebuilt rather than reused: `handleEnter` is internal
 * to `@blocknote/core` and so is the `splitBlockTr` it calls, while both of
 * that function's own dependencies are exported. Splitting a block is also
 * where a quote gets lost — `splitBlockTr` passes `attrs: {}` unless asked
 * otherwise — and in this Space a quote is a prop on the block, so a user
 * pressing Enter inside a quote would drop out of it (A7b).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `replaceBlocks` takes it. */
type BlockSpec = Readonly<Record<string, unknown>>;

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content: unknown;
}

/**
 * Opens an editor holding the given blocks.
 * @param blocks - What to put in the document.
 * @returns The editor and the element it rendered into.
 */
function open(blocks: readonly BlockSpec[]): {
  editor: ReturnType<typeof buildDocumentEditor>;
  root: HTMLElement;
} {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, root };
}

/** The document as plain records, for assertions. */
function blocksOf(editor: ReturnType<typeof buildDocumentEditor>): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

/**
 * Puts the caret at the end of the block at the given index.
 * @param editor - The editor to move the caret in.
 * @param index - Which top-level block.
 */
function caretToEndOf(
  editor: ReturnType<typeof buildDocumentEditor>,
  index: number,
): void {
  editor.setTextCursorPosition(
    (editor.document as unknown as { id: string }[])[index]!.id,
    'end',
  );
}

/**
 * Feeds one character through the input-rule path, the way typing does.
 * @param editor - The editor to type into.
 * @param text - The character typed.
 * @returns Whether a rule claimed it.
 */
function typeCharacter(
  editor: ReturnType<typeof buildDocumentEditor>,
  text: string,
): boolean {
  const view = editor.prosemirrorView!;
  const { from, to } = view.state.selection;
  return (
    view.someProp('handleTextInput', (handler) =>
      // The fifth argument is what ProseMirror would have done — inserting the
      // character — which a rule that claims the input never calls.
      handler(view, from, to, text, () =>
        view.state.tr.insertText(text, from, to),
      ),
    ) ?? false
  );
}

/**
 * Presses Enter through the keymap, the way the keyboard does.
 * @param editor - The editor to press Enter in.
 * @returns Whether a handler claimed it.
 */
function pressEnter(editor: ReturnType<typeof buildDocumentEditor>): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

describe('the ordered list item draws no number of its own', () => {
  it('registers no indexing plugin', () => {
    const { editor } = open([{ type: 'numberedListItem', content: 'one' }]);
    const keys = editor.prosemirrorState.plugins.map((plugin) =>
      String((plugin as unknown as { key: string }).key),
    );
    expect(keys.filter((key) => key.includes('indexing'))).toEqual([]);
  });

  it('renders no data-index for a decoration to fight over', () => {
    const { root } = open([
      { type: 'numberedListItem', content: 'one' },
      { type: 'numberedListItem', content: 'two' },
    ]);
    expect(root.querySelectorAll('[data-index]')).toHaveLength(0);
  });
});

describe('typing an ordered list into being', () => {
  it('turns "1. " into an ordered item', () => {
    const { editor } = open([{ type: 'paragraph', content: '1.' }]);
    caretToEndOf(editor, 0);
    expect(typeCharacter(editor, ' ')).toBe(true);
    expect(blocksOf(editor)[0]?.type).toBe('numberedListItem');
  });

  it('pins no starting number, however the user numbered the line', () => {
    // Choosing where a list starts is #944; until then the number a user
    // happens to type is the trigger, not a value to store.
    const { editor } = open([{ type: 'paragraph', content: '5.' }]);
    caretToEndOf(editor, 0);
    expect(typeCharacter(editor, ' ')).toBe(true);
    const [block] = blocksOf(editor);
    expect(block?.type).toBe('numberedListItem');
    expect(block?.props['start']).toBeUndefined();
    expect(block?.props['number']).toBeUndefined();
  });

  it('leaves a heading alone', () => {
    const { editor } = open([
      { type: 'heading', props: { level: 1 }, content: '1.' },
    ]);
    caretToEndOf(editor, 0);
    typeCharacter(editor, ' ');
    expect(blocksOf(editor)[0]?.type).toBe('heading');
  });
});

describe('the shorthands the other two lists ship with', () => {
  const SHORTHANDS = [
    { typed: '- ', type: 'bulletListItem', props: {} },
    { typed: '[] ', type: 'checkListItem', props: { checked: false } },
    { typed: '[x] ', type: 'checkListItem', props: { checked: true } },
  ] as const;

  SHORTHANDS.forEach(({ typed, type, props }) => {
    it(`turns "${typed}" into ${type}`, () => {
      const before = typed.slice(0, -1);
      const editor = open([{ type: 'paragraph', content: before }]).editor;
      caretToEndOf(editor, 0);
      expect(typeCharacter(editor, ' ')).toBe(true);
      const [block] = blocksOf(editor);
      expect(block?.type).toBe(type);
      Object.entries(props).forEach(([key, value]) => {
        expect(block?.props[key]).toBe(value);
      });
    });
  });
});

describe('Enter inside an ordered list', () => {
  it('takes an empty item back to a paragraph', () => {
    const { editor } = open([{ type: 'numberedListItem', content: '' }]);
    caretToEndOf(editor, 0);
    expect(pressEnter(editor)).toBe(true);
    expect(blocksOf(editor)).toHaveLength(1);
    expect(blocksOf(editor)[0]?.type).toBe('paragraph');
  });

  it('splits a non-empty item into another item', () => {
    const { editor } = open([{ type: 'numberedListItem', content: 'one' }]);
    caretToEndOf(editor, 0);
    expect(pressEnter(editor)).toBe(true);
    const blocks = blocksOf(editor);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.type).toBe('numberedListItem');
  });

  it('keeps the new item inside the quote it was split in', () => {
    const { editor } = open([
      { type: 'numberedListItem', props: { quoted: true }, content: 'one' },
    ]);
    caretToEndOf(editor, 0);
    expect(pressEnter(editor)).toBe(true);
    const blocks = blocksOf(editor);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.props['quoted']).toBe(true);
    expect(blocks[1]?.props['quoted']).toBe(true);
  });

  it('does the same with a run of the item selected', () => {
    // Pressing Enter over a selection replaces it, and the two halves are
    // still the item they were split out of. Reaching that needs this handler
    // to take the key: whatever runs in its place splits by the schema alone,
    // and the schema knows nothing of the prop a quote is made of.
    const { editor } = open([
      { type: 'bulletListItem', props: { quoted: true }, content: 'alpha' },
    ]);
    const view = editor.prosemirrorView!;
    // Over `lph`, which leaves a character either side of the split.
    const start = view.state.doc.resolve(3 + 1);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.between(start, view.state.doc.resolve(3 + 4)),
      ),
    );
    expect(pressEnter(editor)).toBe(true);

    const blocks = blocksOf(editor);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.type)).toEqual([
      'bulletListItem',
      'bulletListItem',
    ]);
    expect(blocks.map((block) => block.props['quoted'])).toEqual([true, true]);
  });
});

describe('typing a quote into being', () => {
  // `> ` opened a quote before this editor changed underneath it: the body ran
  // on StarterKit, whose Blockquote ships that shorthand, and the extensions
  // file said every list, quote and code block it ships behaves as it does.
  //
  // Here a quote is a prop rather than a node, so the shorthand sets the prop
  // and leaves the block the type it already was.
  it('turns "> " into a quote, leaving the block its own type', () => {
    const { editor } = open([{ type: 'paragraph', content: '>' }]);
    caretToEndOf(editor, 0);
    expect(typeCharacter(editor, ' ')).toBe(true);
    const [block] = blocksOf(editor);
    expect(block?.type).toBe('paragraph');
    expect(block?.props['quoted']).toBe(true);
  });

  it('quotes a heading without taking the heading away', () => {
    const { editor } = open([
      { type: 'heading', props: { level: 2 }, content: '>' },
    ]);
    caretToEndOf(editor, 0);
    expect(typeCharacter(editor, ' ')).toBe(true);
    const [block] = blocksOf(editor);
    expect(block?.type).toBe('heading');
    expect(block?.props['level']).toBe(2);
    expect(block?.props['quoted']).toBe(true);
  });
});
