// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A4, A5, A6, A14, design §6.1–§6.3: what a formula draws.
 *
 * A formula block renders KaTeX in display mode, an inline one in text mode.
 * An empty source shows the "add a formula" placeholder, a source KaTeX cannot
 * parse shows the "formula has an error" face once its popup is closed. The
 * popup is BlockNote's `bn-preview-with-source-popup`, open when it carries
 * `data-open="true"`; it is laid out like the AI composer: a title row with
 * the formula's name and a close button, the source, then the confirm button
 * below it. A read-only body never opens it, whether by a click or by a
 * selection dragged into an inline formula's source.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
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
 * A mounted document holding the given blocks.
 * @param blocks - The body, in BlockNote's own shape.
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
 * Waits for an element to appear under the root.
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
 * Presses the pointer on an element the way a click does.
 * @param element - What is clicked.
 */
function click(element: HTMLElement): void {
  fireEvent.mouseDown(element);
  fireEvent.mouseUp(element);
  fireEvent.click(element);
}

/**
 * Whether any formula's popup is open.
 * @param root - Where to look.
 * @returns True when one carries `data-open="true"`.
 */
function anyOpen(root: HTMLElement): boolean {
  return root.querySelector('.bn-preview-with-source-popup[data-open="true"]') !== null;
}

/**
 * The position just inside the first inline formula's source.
 * @param editor - The editor.
 * @returns The position, or -1 when there is none.
 */
function insideInlineSource(editor: Editor): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'math') at = pos + 2;
    return at < 0;
  });
  return at;
}

describe('rendering', () => {
  it('draws a formula block in display mode', async () => {
    const { root } = open([{ type: 'mathBlock', content: '\\frac{a}{b}' }]);
    expect(await appear(root, '.katex-display')).toBeTruthy();
  });

  it('scrolls a formula block sideways in a scroller of its own (§6.1)', async () => {
    const { root } = open([{ type: 'mathBlock', content: '\\frac{a}{b}' }]);
    const display = await appear(root, '.katex-display');
    const viewport = display.closest('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport!.closest('[data-scrollbars="horizontal"]')).not.toBeNull();
  });

  it('draws an inline formula in text mode', async () => {
    const { root } = open([{ type: 'paragraph', content: ['x ', { type: 'math', content: 'E = mc^2' }] }]);
    const katex = await appear(root, '.katex');
    expect(katex.closest('.katex-display')).toBeNull();
  });

  it('shows the placeholder for an empty formula', async () => {
    const { root } = open([{ type: 'mathBlock', content: '' }]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.empty'));
    });
  });

  it('shows the error face for a source that does not parse, once closed', async () => {
    const { root } = open([{ type: 'mathBlock', content: '\\frac{a}{b' }]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.error'));
    });
  });
});

describe('the popup', () => {
  it('opens on a click', async () => {
    const { root } = open([{ type: 'mathBlock', content: '\\frac{a}{b}' }]);
    click(await appear(root, '.katex-display'));
    await vi.waitFor(() => {
      expect(anyOpen(root)).toBe(true);
    });
  });

  it('carries the title and the confirm button below the source, and no close button', async () => {
    const { root } = open([{ type: 'mathBlock', content: '\\frac{a}{b}' }]);
    const popup = await appear(root, '.bn-source-block-popup');
    expect(popup.textContent).toContain(t('spaces.document.commands.formula'));
    expect(popup.querySelectorAll('button')).toHaveLength(1);
    const confirm = [...popup.querySelectorAll('button')].find(
      (button) => button.textContent === t('spaces.document.math.ok'),
    );
    const source = popup.querySelector('[data-editable], .bn-inline-content');
    expect(confirm).toBeDefined();
    expect(source).not.toBeNull();
    expect(source!.compareDocumentPosition(confirm!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('a read-only body', () => {
  it('does not open the popup on a click', async () => {
    const { editor, root } = open([{ type: 'mathBlock', content: '\\frac{a}{b}' }]);
    editor.isEditable = false;
    click(await appear(root, '.katex-display'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anyOpen(root)).toBe(false);
  });

  it('does not open the popup when a selection is dragged into an inline formula', async () => {
    const { editor, root } = open([{ type: 'paragraph', content: ['x ', { type: 'math', content: 'E = mc^2' }, ' y'] }]);
    await appear(root, '.katex');
    editor.isEditable = false;
    const view = editor.prosemirrorView!;
    const at = insideInlineSource(editor);
    expect(at).toBeGreaterThan(0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, at)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(anyOpen(root)).toBe(false);
  });
});
