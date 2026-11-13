// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A5, design §6.3: closing a formula's box keeps what was typed.
 *
 * The formula in the body is the live preview, as in Notion, AFFiNE and
 * BlockNote's own formula: every key shows there as it is typed. Enter, the
 * confirm button, Escape and moving away all close the box and keep the
 * edit; Cmd+Z undoes it like any other typing. The box has no close button.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { SourceBlockWithPreviewExtension } from '@blocknote/core/extensions';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, t } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/**
 * A mounted body holding the given blocks.
 * @param blocks - The body.
 * @returns The editor and the element it is mounted in.
 */
function open(blocks: unknown[]): { editor: Editor; root: HTMLElement } {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, root };
}

/**
 * Waits for an element to appear.
 * @param root - Where to look.
 * @param selector - What to look for.
 * @returns The element.
 */
async function appear(root: HTMLElement, selector: string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const found = root.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`no ${selector} yet`);
    return found;
  });
}

/**
 * Where the first node of a type starts.
 * @param editor - The editor.
 * @param name - The node type.
 * @returns Its position.
 */
function posOf(editor: Editor, name: string): number {
  let at = -1;
  editor.prosemirrorView!.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === name) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The first formula's source.
 * @param editor - The editor.
 * @param name - `mathBlock` or `math`.
 * @returns Its text.
 */
function sourceOf(editor: Editor, name: string): string {
  return editor.prosemirrorView!.state.doc.nodeAt(posOf(editor, name))!.textContent;
}

/**
 * Types at the end of the first formula's source, as the user does in the box.
 * @param editor - The editor.
 * @param name - `mathBlock` or `math`.
 * @param text - What is typed.
 */
function typeAtEnd(editor: Editor, name: string, text: string): void {
  const view = editor.prosemirrorView!;
  const at = posOf(editor, name);
  const end = at + view.state.doc.nodeAt(at)!.nodeSize - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).insertText(text));
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
 * Opens a block formula's box with the caret at the end of its source.
 * @param editor - The editor.
 * @param root - Where it is mounted.
 */
async function openBlock(editor: Editor, root: HTMLElement): Promise<void> {
  fireEvent.mouseDown(await appear(root, '.katex-display'));
  await vi.waitFor(() => {
    expect(root.querySelector('.bn-preview-with-source-popup[data-open="true"]')).not.toBeNull();
  });
}

/**
 * Opens an inline formula's box by putting the caret at the end of its source.
 * @param editor - The editor.
 * @param root - Where it is mounted.
 */
async function openInline(editor: Editor, root: HTMLElement): Promise<void> {
  fireEvent.mouseDown(await appear(root, '.katex'));
  await vi.waitFor(() => {
    expect(root.querySelector('.bn-preview-with-source-popup[data-open="true"]')).not.toBeNull();
  });
}

/**
 * Whether no formula box is open.
 * @param root - Where the body is mounted.
 * @returns True when all are closed.
 */
function allClosed(root: HTMLElement): boolean {
  return root.querySelector('.bn-preview-with-source-popup[data-open="true"]') === null;
}

/**
 * The button in the open box whose label or text is the given words.
 * @param root - Where the body is mounted.
 * @param words - Its label or text.
 * @returns The button.
 */
function boxButton(root: HTMLElement, words: string): HTMLElement {
  const box = root.querySelector('.bn-preview-with-source-popup[data-open="true"] .bn-source-block-popup')!;
  return [...box.querySelectorAll<HTMLElement>('button')].find(
    (button) => button.getAttribute('aria-label') === words || button.textContent === words,
  )!;
}

const BLOCK = [{ type: 'mathBlock', content: 'a+b' }];
const INLINE = [{ type: 'paragraph', content: ['x ', { type: 'math', content: 'a+b' }, ' y'] }];

/**
 * Moves the caret into the line after the formula, as a click there does.
 * @param editor - The editor.
 */
function caretInLastLine(editor: Editor): void {
  const view = editor.prosemirrorView!;
  const end = view.state.doc.content.size - 3;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
}

describe('closing a block formula’s box (§6.3)', () => {
  it('has no close button, only the confirm', async () => {
    const { editor, root } = open(BLOCK);
    await openBlock(editor, root);
    const box = root.querySelector('.bn-preview-with-source-popup[data-open="true"] .bn-source-block-popup')!;
    expect([...box.querySelectorAll('button')].map((button) => button.textContent)).toEqual([t('spaces.document.math.ok')]);
  });

  it.each(['confirm', 'Enter', 'Escape', 'moving away'] as const)('keeps the edit on %s', async (how) => {
    const { editor, root } = open([...BLOCK, { type: 'paragraph', content: 'after' }]);
    await openBlock(editor, root);
    typeAtEnd(editor, 'mathBlock', 'c');
    if (how === 'confirm') fireEvent.click(boxButton(root, t('spaces.document.math.ok')));
    else if (how === 'moving away') caretInLastLine(editor);
    else press(editor, how);
    await vi.waitFor(() => {
      expect(allClosed(root)).toBe(true);
    });
    expect(sourceOf(editor, 'mathBlock')).toBe('a+bc');
    expect(editor.getExtension(SourceBlockWithPreviewExtension)?.store.state.popupOpen).toBeUndefined();
  });
});

describe('closing an inline formula’s box (§6.3)', () => {
  it.each(['Enter', 'Escape', 'ArrowRight'] as const)('keeps the edit on %s', async (key) => {
    const { editor, root } = open(INLINE);
    await openInline(editor, root);
    typeAtEnd(editor, 'math', 'c');
    press(editor, key);
    expect(sourceOf(editor, 'math')).toBe('a+bc');
  });

  it('keeps the edit when the confirm button closes it, the caret after the formula', async () => {
    const { editor, root } = open(INLINE);
    await openInline(editor, root);
    typeAtEnd(editor, 'math', 'c');
    fireEvent.click(boxButton(root, t('spaces.document.math.ok')));
    expect(sourceOf(editor, 'math')).toBe('a+bc');
    const at = posOf(editor, 'math');
    expect(editor.prosemirrorView!.state.selection.from).toBe(
      at + editor.prosemirrorView!.state.doc.nodeAt(at)!.nodeSize,
    );
  });
});
