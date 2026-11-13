// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A5, design §6.3: what closing a formula's box does to what was
 * typed in it.
 *
 * The box asks for a confirm, like the body's other boxes that take an input
 * and a confirm (the link field, the AI composer): confirming keeps the edit,
 * and the close button, Escape and a press outside the box put the source
 * back to what it was when the box opened. Leaving an inline source with the
 * arrow keys is moving on through the text, and keeps it.
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

describe('closing a block formula’s box (§6.3)', () => {
  it('keeps the edit on the confirm button', async () => {
    const { editor, root } = open(BLOCK);
    await openBlock(editor, root);
    typeAtEnd(editor, 'mathBlock', 'c');
    fireEvent.click(boxButton(root, t('spaces.document.math.ok')));
    await vi.waitFor(() => {
      expect(allClosed(root)).toBe(true);
    });
    expect(sourceOf(editor, 'mathBlock')).toBe('a+bc');
  });

  it('keeps the edit on Enter', async () => {
    const { editor, root } = open(BLOCK);
    await openBlock(editor, root);
    typeAtEnd(editor, 'mathBlock', 'c');
    press(editor, 'Enter');
    await vi.waitFor(() => {
      expect(allClosed(root)).toBe(true);
    });
    expect(sourceOf(editor, 'mathBlock')).toBe('a+bc');
  });

  it('puts the source back on the close button', async () => {
    const { editor, root } = open(BLOCK);
    await openBlock(editor, root);
    typeAtEnd(editor, 'mathBlock', 'c');
    fireEvent.click(boxButton(root, t('spaces.document.math.close')));
    await vi.waitFor(() => {
      expect(allClosed(root)).toBe(true);
    });
    expect(sourceOf(editor, 'mathBlock')).toBe('a+b');
  });

  it('puts the source back on Escape', async () => {
    const { editor, root } = open(BLOCK);
    await openBlock(editor, root);
    typeAtEnd(editor, 'mathBlock', 'c');
    press(editor, 'Escape');
    await vi.waitFor(() => {
      expect(allClosed(root)).toBe(true);
    });
    expect(sourceOf(editor, 'mathBlock')).toBe('a+b');
  });

  it('puts the source back on a press outside the box', async () => {
    const { editor, root } = open([...BLOCK, { type: 'paragraph', content: 'after' }]);
    await openBlock(editor, root);
    typeAtEnd(editor, 'mathBlock', 'c');
    const outside = [...root.querySelectorAll<HTMLElement>('.bn-inline-content')].find((el) => el.textContent === 'after')!;
    fireEvent.pointerDown(outside);
    expect(sourceOf(editor, 'mathBlock')).toBe('a+b');
  });

  it('leaves the source alone when nothing was typed', async () => {
    const { editor, root } = open(BLOCK);
    await openBlock(editor, root);
    const before = editor.prosemirrorView!.state.doc;
    press(editor, 'Escape');
    await vi.waitFor(() => {
      expect(allClosed(root)).toBe(true);
    });
    expect(editor.prosemirrorView!.state.doc.eq(before)).toBe(true);
    expect(editor.getExtension(SourceBlockWithPreviewExtension)?.store.state.popupOpen).toBeUndefined();
  });
});

describe('closing an inline formula’s box (§6.3)', () => {
  it('keeps the edit on Enter', async () => {
    const { editor, root } = open(INLINE);
    await openInline(editor, root);
    typeAtEnd(editor, 'math', 'c');
    press(editor, 'Enter');
    expect(sourceOf(editor, 'math')).toBe('a+bc');
  });

  it('keeps the edit when the arrow keys walk out of the source', async () => {
    const { editor, root } = open(INLINE);
    await openInline(editor, root);
    typeAtEnd(editor, 'math', 'c');
    press(editor, 'ArrowRight');
    expect(sourceOf(editor, 'math')).toBe('a+bc');
  });

  it('puts the source back on Escape, the caret after the formula', async () => {
    const { editor, root } = open(INLINE);
    await openInline(editor, root);
    typeAtEnd(editor, 'math', 'c');
    press(editor, 'Escape');
    expect(sourceOf(editor, 'math')).toBe('a+b');
    const at = posOf(editor, 'math');
    expect(editor.prosemirrorView!.state.selection.from).toBe(
      at + editor.prosemirrorView!.state.doc.nodeAt(at)!.nodeSize,
    );
  });

  it('puts the source back on the close button', async () => {
    const { editor, root } = open(INLINE);
    await openInline(editor, root);
    typeAtEnd(editor, 'math', 'c');
    fireEvent.click(boxButton(root, t('spaces.document.math.close')));
    expect(sourceOf(editor, 'math')).toBe('a+b');
  });
});
