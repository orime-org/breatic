// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A4 · A4b: markdown shorthand answers the same as the menu.
 *
 * Three controls write a block type — the menu row, the chord, and the
 * shorthand typed at the head of a line — and §3.2 is one table over all of
 * them. `> ` was already routed through it (A7); these are the other two
 * shapes the table names, and the one pair it lets coexist is where they came
 * apart: an ordered item is `numberedListItem`, and the same thing on a
 * heading is the `numbered` prop, so a rule that only knows types answers a
 * different question.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentChordsExtension } from '@web/spaces/document/document-block-chords';
import { runBlockType } from '@web/spaces/document/document-block-run';
import type { BlockTypeId } from '@web/spaces/document/document-block-ticks';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** The part of a block these cases judge. */
interface Shape {
  readonly type: string;
  readonly level: unknown;
  readonly numbered: unknown;
}

/**
 * Opens an editor holding one block, with the caret in it.
 * @param block - The block to start from.
 * @returns The editor.
 */
function open(
  block: Record<string, unknown>,
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentChordsExtension()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [block] as never);
  editor.setTextCursorPosition(
    (editor.document as { id: string }[])[0]!.id,
    'end',
  );
  return editor;
}

/** The shape of the one block. */
function shapeOf(editor: ReturnType<typeof buildDocumentEditor>): Shape {
  const block = (editor.document as {
    type: string;
    props: Record<string, unknown>;
  }[])[0]!;
  return {
    type: block.type,
    level: block.props['level'],
    numbered: block.props['numbered'],
  };
}

/**
 * Types the given text one character at a time, through the input rules.
 * @param editor - The editor to type in.
 * @param text - What to type.
 */
function type(
  editor: ReturnType<typeof buildDocumentEditor>,
  text: string,
): void {
  const view = editor.prosemirrorView!;
  for (const character of text) {
    const { from, to } = view.state.selection;
    const claimed =
      view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr),
      ) ?? false;
    if (!claimed) {
      view.dispatch(view.state.tr.insertText(character, from, to));
    }
  }
}

/** Each shorthand, beside the row it stands for. */
const SHORTHANDS: { typed: string; row: BlockTypeId }[] = [
  { typed: '# ', row: 'heading-1' },
  { typed: '## ', row: 'heading-2' },
  { typed: '### ', row: 'heading-3' },
  { typed: '1. ', row: 'ordered-list' },
  { typed: '- ', row: 'bullet-list' },
  { typed: '[] ', row: 'task-list' },
  { typed: '``` ', row: 'code-block' },
];

/** The blocks a shorthand is typed from. */
const STARTS: { label: string; block: Record<string, unknown> }[] = [
  { label: 'a paragraph', block: { type: 'paragraph', content: '' } },
  {
    label: 'an ordered item',
    block: { type: 'numberedListItem', content: '' },
  },
  {
    label: 'a level-one heading',
    block: { type: 'heading', props: { level: 1 }, content: '' },
  },
  {
    label: 'a numbered heading',
    block: {
      type: 'heading',
      props: { level: 1, numbered: true },
      content: '',
    },
  },
];

/** Whether pressing that row on that block would be a cancel. */
function cancels(block: Record<string, unknown>, row: BlockTypeId): boolean {
  const props = (block['props'] ?? {}) as Record<string, unknown>;
  if (row === 'ordered-list') {
    return block['type'] === 'numberedListItem' || props['numbered'] === true;
  }
  return false;
}

describe('the shorthand and the menu row answer the same', () => {
  STARTS.forEach(({ label, block }) => {
    SHORTHANDS.filter(({ row }) => !cancels(block, row)).forEach(({ typed, row }) => {
      it(`${JSON.stringify(typed)} on ${label}`, () => {
        const byMenu = open({ ...block });
        runBlockType(byMenu, row);
        const expected = shapeOf(byMenu);

        const byTyping = open({ ...block });
        type(byTyping, typed);

        expect(shapeOf(byTyping)).toEqual(expected);
        // And the shorthand itself was consumed, not left in the text.
        expect(byTyping.prosemirrorState.doc.textContent).toBe('');
      });
    });
  });
});

describe('a shorthand typed in front of text keeps that text', () => {
  // Every case above starts from an empty block, where a rule that replaces
  // the block's content and one that keeps it come out the same. The rule
  // BlockNote ships for the code block passes `content: []`, which replaces
  // it — so the text a writer had would be gone, while the menu row on the
  // same block keeps it. §3.2 is one answer per transition whichever control
  // asked, so the shorthand goes through the same table.
  SHORTHANDS.forEach(({ typed, row }) => {
    it(`${JSON.stringify(typed)} leaves the text where it was`, () => {
      const byTyping = open({ type: 'paragraph', content: 'hello' });
      // In front of the text, which is where a writer reaches for a shorthand.
      byTyping.setTextCursorPosition(
        (byTyping.document as unknown as { id: string }[])[0]!.id,
        'start',
      );
      type(byTyping, typed);

      expect(byTyping.prosemirrorState.doc.textContent).toBe('hello');
      expect(shapeOf(byTyping).type).toBe(shapeOf(openByMenu(row)).type);
    });
  });
});

/**
 * The block the menu row leaves behind, from the same starting text.
 * @param row - Which row.
 * @returns The editor it was run in.
 */
function openByMenu(row: BlockTypeId): ReturnType<typeof open> {
  const editor = open({ type: 'paragraph', content: 'hello' });
  runBlockType(editor, row);
  return editor;
}

describe('the shorthand sets rather than toggles', () => {
  // Pressing a menu row the block already carries is a cancel — the row is
  // ticked, and pressing a ticked row unticks it. A shorthand has no ticked
  // state to press: it is typed at the head of a line and says what that line
  // is. So the one pair where the two controls differ is the block that
  // already carries the row.
  it('leaves an ordered item ordered', () => {
    const editor = open({ type: 'numberedListItem', content: '' });
    type(editor, '1. ');

    expect(shapeOf(editor).type).toBe('numberedListItem');
    expect(editor.prosemirrorState.doc.textContent).toBe('');
  });

  it('leaves a numbered heading numbered, and a heading', () => {
    const editor = open({
      type: 'heading',
      props: { level: 2, numbered: true },
      content: '',
    });
    type(editor, '1. ');

    expect(shapeOf(editor)).toEqual({
      type: 'heading',
      level: 2,
      numbered: true,
    });
  });
});

describe('the code shorthand carries the language typed after the ticks', () => {
  // The one thing a menu row cannot say: there is a single code row, so the
  // language can only arrive from what the writer typed. The first whitespace
  // is what closes the pattern, so the name never holds one.
  it('sets it from what was typed', () => {
    const editor = open({ type: 'paragraph', content: '' });
    type(editor, '```ts ');

    const block = (editor.document as { type: string; props: Record<string, unknown> }[])[0]!;
    expect(block.type).toBe('codeBlock');
    expect(block.props['language']).toBe('ts');
  });

  it('leaves the schema default when the ticks stand alone', () => {
    const typed = open({ type: 'paragraph', content: '' });
    type(typed, '``` ');
    const byMenu = open({ type: 'paragraph', content: '' });
    runBlockType(byMenu, 'code-block');

    const languageOf = (editor: ReturnType<typeof open>): unknown =>
      (editor.document as { props: Record<string, unknown> }[])[0]!.props['language'];
    expect(languageOf(typed)).toBe(languageOf(byMenu));
  });
});
