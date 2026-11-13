// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A2, A3: typing `$$x$$` turns into an inline formula the moment
 * the closing `$` is typed; a single `$` never does.
 *
 * The conversion is its own undo step (design 6.4): the closing `$` lands as
 * text first, and the conversion follows in a transaction of its own, so
 * Cmd+Z goes back to the text `$$x$$`. Only a `$` that came through
 * `handleTextInput` arms it, so the text an undo brings back is never
 * converted again.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';

import { open, select, settled, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';
import { nodeSource } from '@web/spaces/document/__tests__/math-fixtures';

afterEach(unmountAll);

/**
 * Types one character the way a keystroke reaches the editor: the
 * `handleTextInput` props first, the plain insert when none takes it.
 * @param editor - The editor.
 * @param ch - The character.
 */
function typeChar(editor: Editor, ch: string): void {
  const view = editor.prosemirrorView!;
  const { from, to } = view.state.selection;
  const insert = (): ReturnType<typeof view.state.tr.insertText> => view.state.tr.insertText(ch, from, to);
  const taken = view.someProp('handleTextInput', (handler) => handler(view, from, to, ch, insert)) ?? false;
  if (!taken) view.dispatch(insert());
}

/**
 * Types words one keystroke at a time and lets the conversion that follows
 * a keystroke run.
 * @param editor - The editor.
 * @param words - The words.
 */
async function typeWords(editor: Editor, words: string): Promise<void> {
  for (const ch of words) typeChar(editor, ch);
  await settled();
}

/**
 * Presses a key through the editor's key handlers.
 * @param editor - The editor.
 * @param key - The key.
 * @returns Whether a handler took it.
 */
function press(editor: Editor, key: string): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false;
}

/**
 * The first text block's inline content, with formulas written as `[math:src]`.
 * @param editor - The editor.
 * @returns The content as one string.
 */
function line(editor: Editor): string {
  let block: PMNode | null = null;
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (block === null && node.isTextblock) block = node;
    return block === null;
  });
  const parts: string[] = [];
  (block as PMNode | null)?.forEach((child) => {
    parts.push(child.type.name === 'math' ? `[math:${nodeSource(child)}]` : (child.text ?? ''));
  });
  return parts.join('');
}

/**
 * Where the first node of a type ends.
 * @param editor - The editor.
 * @param name - The node type.
 * @returns The position right after it, or -1.
 */
function endOf(editor: Editor, name: string): number {
  let end = -1;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (end < 0 && node.type.name === name) end = pos + node.nodeSize;
    return end < 0;
  });
  return end;
}

/**
 * Opens a body of one block and puts the caret at its end.
 * @param block - The block.
 * @returns The editor and its undo manager.
 */
function openAtEnd(block: Record<string, unknown>): ReturnType<typeof open> {
  const opened = open([block]);
  const ids = opened.editor.document as unknown as { id: string }[];
  opened.editor.setTextCursorPosition(ids[0]!.id, 'end');
  return opened;
}

describe('typing `$$x$$` (A2)', () => {
  it('turns into a formula when the closing `$` is typed, caret after it', async () => {
    const { editor } = openAtEnd({ type: 'paragraph', content: 'area ' });
    await typeWords(editor, '$$\\pi r^2$$');
    expect(line(editor)).toBe('area [math:\\pi r^2]');
    expect(editor.prosemirrorView!.state.selection.from).toBe(endOf(editor, 'math'));
  });

  it.each([
    ['a space right inside the opening', '$$ x$$'],
    ['a space right inside the closing', '$$x $$'],
  ])('stays text with %s', async (_label, words) => {
    const { editor } = openAtEnd({ type: 'paragraph', content: '' });
    await typeWords(editor, words);
    expect(line(editor)).toBe(words);
  });

  it.each([
    ['a backslash', '\\'],
    ['a dollar sign', '$'],
  ])('stays text right after %s', async (_label, before) => {
    const { editor } = openAtEnd({ type: 'paragraph', content: before });
    await typeWords(editor, '$$x$$');
    expect(line(editor)).toBe(`${before}$$x$$`);
  });

  it('stays text in a code block', async () => {
    const { editor } = openAtEnd({ type: 'codeBlock', content: '' });
    await typeWords(editor, '$$x$$');
    expect(line(editor)).toBe('$$x$$');
  });

  it('stays text in inline code', async () => {
    const { editor } = open([
      { type: 'paragraph', content: [{ type: 'text', text: 'ab', styles: { code: true } }] },
    ]);
    // Between the two letters, where typing carries the code mark.
    select(editor, 4);
    await typeWords(editor, '$$x$$');
    expect(line(editor)).toBe('a$$x$$b');
  });

});

describe('a single `$` (A3)', () => {
  // Titled by label: vitest reads `$name` in a title as a placeholder.
  it.each([
    ['a price', 'price $5'],
    ['a pair of single dollar signs', 'let $x$ be'],
  ])('never converts %s', async (_label, words) => {
    const { editor } = openAtEnd({ type: 'paragraph', content: '' });
    await typeWords(editor, words);
    expect(line(editor)).toBe(words);
  });
});

describe('taking a conversion back (A2)', () => {
  it('undo returns the text `$$x$$`, and it is not converted again', async () => {
    const { editor, manager } = openAtEnd({ type: 'paragraph', content: '' });
    await typeWords(editor, '$$x$$');
    expect(line(editor)).toBe('[math:x]');

    editor.undo();
    await settled();
    expect(line(editor)).toBe('$$x$$');

    // The next keystroke and the redraw after it leave the text alone.
    manager.stopCapturing();
    await typeWords(editor, ' ');
    expect(line(editor)).toBe('$$x$$ ');
  });

  it('Backspace right after converting turns it back into the text `$$x$$`', async () => {
    const { editor } = openAtEnd({ type: 'paragraph', content: '' });
    await typeWords(editor, '$$x$$');
    expect(line(editor)).toBe('[math:x]');

    expect(press(editor, 'Backspace')).toBe(true);
    expect(line(editor)).toBe('$$x$$');
  });
});
