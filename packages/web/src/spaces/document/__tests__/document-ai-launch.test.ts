// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the AI output dialog takes from the body when it opens (inner#1860,
 * design §5.2, §5.4): the block a result is inserted under, and the context
 * Markdown sent with the selection, cut to the budget around the selection.
 *
 * Real document editors throughout: which block holds a position depends on
 * the schema's wrappers and the table rules, which a stand-in would not have.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { aiCapture, aiContextOf, aiInsertBlockId } from '@web/spaces/document/document-ai-launch';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding the given blocks.
 * @param blocks - The blocks, as the block API takes them.
 * @returns The editor.
 */
function open(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where some words start in the body.
 * @param editor - The editor.
 * @param words - Words inside one text node.
 * @returns The position of their first letter.
 * @throws {Error} When no text node holds them.
 */
function at(editor: Editor, words: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    const index = node.isText ? (node.text ?? '').indexOf(words) : -1;
    if (index >= 0) found = pos + index;
    return found < 0;
  });
  if (found < 0) throw new Error(`no text holds ${JSON.stringify(words)}`);
  return found;
}

/**
 * Selects between two positions.
 * @param editor - The editor.
 * @param from - The anchor.
 * @param to - The head.
 */
function select(editor: Editor, from: number, to: number): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

/**
 * The id of the block container holding some words.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The id.
 */
function blockHolding(editor: Editor, words: string): string {
  const $pos = editor.prosemirrorState.doc.resolve(at(editor, words));
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth);
    if (node.type.name === 'blockContainer') return String(node.attrs.id);
  }
  throw new Error(`no block holds ${JSON.stringify(words)}`);
}

/**
 * The top-level block ids, in order.
 * @param editor - The editor.
 * @returns The ids.
 */
function topIds(editor: Editor): string[] {
  return (editor.document as Array<{ id: string }>).map((block) => block.id);
}

describe('the range captured (§4.6, Plate captureTextRange)', () => {
  it('keeps a selection inside one block as it is', () => {
    const editor = open([{ type: 'paragraph', content: 'Intro: x y z end.' }]);
    select(editor, at(editor, 'x y z'), at(editor, 'x y z') + 5);
    expect(aiCapture(editor.prosemirrorState)).toEqual({
      range: { from: at(editor, 'x y z'), to: at(editor, 'x y z') + 5 },
      firstId: null,
      lastId: null,
    });
  });

  it('widens a selection across blocks to the whole blocks it touches', () => {
    const editor = open([
      { type: 'paragraph', content: 'Before.' },
      { type: 'heading', content: 'Head line' },
      { type: 'paragraph', content: 'Body text' },
      { type: 'paragraph', content: 'After.' },
    ]);
    select(editor, at(editor, 'line'), at(editor, 'Body') + 4);
    const captured = aiCapture(editor.prosemirrorState)!;
    expect([captured.firstId, captured.lastId]).toEqual([blockHolding(editor, 'Head'), blockHolding(editor, 'Body')]);
    expect(editor.prosemirrorState.doc.textBetween(captured.range.from, captured.range.to, '|')).toBe('Head line|Body text');
  });

  it('leaves out the block a selection ends at the start of', () => {
    const editor = open([
      { type: 'paragraph', content: 'One' },
      { type: 'paragraph', content: 'Two' },
    ]);
    select(editor, at(editor, 'One') + 1, at(editor, 'Two'));
    const captured = aiCapture(editor.prosemirrorState)!;
    expect([captured.firstId, captured.lastId]).toEqual([null, null]);
    expect(editor.prosemirrorState.doc.textBetween(captured.range.from, captured.range.to)).toBe('ne');
  });

  it('leaves out the block a selection starts at the end of', () => {
    const editor = open([
      { type: 'paragraph', content: 'One' },
      { type: 'paragraph', content: 'Two' },
      { type: 'paragraph', content: 'Three' },
    ]);
    select(editor, at(editor, 'One') + 3, at(editor, 'Three') + 2);
    const captured = aiCapture(editor.prosemirrorState)!;
    expect([captured.firstId, captured.lastId]).toEqual([blockHolding(editor, 'Two'), blockHolding(editor, 'Three')]);
  });

  it('takes the whole table a selection runs into from outside', () => {
    const editor = open([{ type: 'paragraph', content: 'Before' }, tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })]);
    select(editor, at(editor, 'Before'), at(editor, 'c') + 1);
    const captured = aiCapture(editor.prosemirrorState)!;
    expect([captured.firstId, captured.lastId]).toEqual([blockHolding(editor, 'Before'), topIds(editor)[1]]);
  });

  it('widens to the whole blocks of one docTable cell when the selection crosses blocks inside it', () => {
    const editor = open([tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })]);
    const cellBlock = blockHolding(editor, 'c');
    editor.insertBlocks([{ type: 'paragraph', content: 'c two' }] as never, cellBlock, 'after');
    select(editor, at(editor, 'c') + 0, at(editor, 'c two') + 3);
    const captured = aiCapture(editor.prosemirrorState)!;
    expect([captured.firstId, captured.lastId]).toEqual([cellBlock, blockHolding(editor, 'c two')]);
  });

  it('captures nothing for a selection without words', () => {
    const editor = open([{ type: 'image', props: { url: 'https://assets.example/a.png' } }, { type: 'paragraph', content: '' }]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.content.size - 1)));
    expect(aiCapture(editor.prosemirrorState)).toBeNull();
  });
});

describe('the insert block (§5.4)', () => {
  it('is the block the selection ends in', () => {
    const editor = open([
      { type: 'paragraph', content: 'Alpha line' },
      { type: 'paragraph', content: 'Bravo line' },
      { type: 'paragraph', content: 'Charlie line' },
    ]);
    select(editor, at(editor, 'Alpha'), at(editor, 'Bravo') + 3);

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(blockHolding(editor, 'Bravo'));
  });

  it('is the block before when the selection ends at the start of the next one', () => {
    // Shift+Down from the start of a paragraph selects it whole and ends at
    // offset 0 of the next block; the block selected is the one before.
    const editor = open([
      { type: 'paragraph', content: 'Alpha line' },
      { type: 'paragraph', content: 'Bravo line' },
    ]);
    select(editor, at(editor, 'Alpha'), at(editor, 'Bravo'));

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(blockHolding(editor, 'Alpha'));
  });

  it('is an image block the selection ends with', () => {
    const editor = open([
      { type: 'paragraph', content: 'Alpha line' },
      { type: 'image', props: { url: 'https://cdn.example/a.png', name: 'a.png' } },
      { type: 'paragraph', content: 'Omega line' },
    ]);
    select(editor, at(editor, 'Alpha'), at(editor, 'Omega'));

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(topIds(editor)[1]);
  });

  it('is a video block the selection ends with', () => {
    const editor = open([
      { type: 'paragraph', content: 'Alpha line' },
      { type: 'video', props: { url: 'https://cdn.example/a.mp4', name: 'a.mp4' } },
      { type: 'paragraph', content: 'Omega line' },
    ]);
    select(editor, at(editor, 'Alpha'), at(editor, 'Omega'));

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(topIds(editor)[1]);
  });

  it('is the whole table when the selection enters it from outside', () => {
    const editor = open([
      { type: 'paragraph', content: 'Intro line' },
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
      { type: 'paragraph', content: 'After line' },
    ]);
    select(editor, at(editor, 'Intro'), at(editor, 'a1') + 1);

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(topIds(editor)[1]);
  });

  it('is the whole table when the selection runs from one cell into another', () => {
    const editor = open([
      { type: 'paragraph', content: 'Intro line' },
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
      { type: 'paragraph', content: 'After line' },
    ]);
    select(editor, at(editor, 'a1'), at(editor, 'b1') + 1);

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(topIds(editor)[1]);
  });

  it('is the block in the cell when the selection stays inside one cell', () => {
    const editor = open([
      { type: 'paragraph', content: 'Intro line' },
      tableBlock({ rows: [{ cells: ['first cell words', 'b1'] }, { cells: ['a2', 'b2'] }] }),
    ]);
    select(editor, at(editor, 'cell'), at(editor, 'cell') + 4);

    expect(aiInsertBlockId(editor.prosemirrorState)).toBe(blockHolding(editor, 'first cell words'));
  });
});

/**
 * Paragraphs of the same length, each named by its number.
 * @param count - How many.
 * @returns Their words.
 */
function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Paragraph ${String(i).padStart(2, '0')} ${'x'.repeat(30)}`);
}

describe('the context sent with the selection (§5.2)', () => {
  it('is the whole document when it fits the budget', () => {
    const words = numbered(5);
    const editor = open(words.map((content) => ({ type: 'paragraph', content })));
    select(editor, at(editor, 'Paragraph 02'), at(editor, 'Paragraph 02') + 12);

    expect(aiContextOf(editor, 10_000).trim()).toBe(words.join('\n\n'));
  });

  it('over the budget, is a run of whole blocks around the selection that fits', () => {
    const words = numbered(10);
    const editor = open(words.map((content) => ({ type: 'paragraph', content })));
    select(editor, at(editor, 'Paragraph 05'), at(editor, 'Paragraph 05') + 12);
    // Three blocks and the blank lines between them fit; a fourth does not.
    const budget = words[0]!.length * 3 + 2 * 2 + 20;

    const context = aiContextOf(editor, budget);

    expect(context.length).toBeLessThanOrEqual(budget);
    expect(context).toContain(words[5]);
    const kept = words.map((w, i) => (context.includes(w) ? i : -1)).filter((i) => i >= 0);
    expect(kept).toHaveLength(3);
    expect(kept).toContain(5);
    expect(kept[kept.length - 1]! - kept[0]!).toBe(2);
  });

  it('cuts inside the block when the selection\'s own block is over the budget', () => {
    const long = `${'a'.repeat(400)} TARGET WORDS ${'b'.repeat(400)}`;
    const editor = open([
      { type: 'paragraph', content: 'Short before.' },
      { type: 'paragraph', content: long },
      { type: 'paragraph', content: 'Short after.' },
    ]);
    select(editor, at(editor, 'TARGET'), at(editor, 'TARGET') + 'TARGET WORDS'.length);

    const context = aiContextOf(editor, 120);

    expect(context.length).toBeLessThanOrEqual(120);
    expect(context).toContain('TARGET WORDS');
  });

  it('keeps the selection when it sits at the very end of a block over the budget', () => {
    const editor = open([{ type: 'paragraph', content: `${'a'.repeat(800)} THE END` }]);
    select(editor, at(editor, 'THE END'), at(editor, 'THE END') + 'THE END'.length);

    const context = aiContextOf(editor, 100);

    expect(context.length).toBeLessThanOrEqual(100);
    expect(context).toContain('THE END');
  });

  it('keeps the selection when it sits at the very start of a block over the budget', () => {
    const editor = open([{ type: 'paragraph', content: `THE START ${'z'.repeat(800)}` }]);
    select(editor, at(editor, 'THE START'), at(editor, 'THE START') + 'THE START'.length);

    const context = aiContextOf(editor, 100);

    expect(context.length).toBeLessThanOrEqual(100);
    expect(context).toContain('THE START');
  });
});
