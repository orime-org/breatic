// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A4, A6, design §6.1–§6.2: what a formula draws.
 *
 * A formula block renders KaTeX in display mode, an inline one in text mode.
 * An empty source shows the "add a formula" placeholder, a source KaTeX cannot
 * parse shows the "formula has an error" face once its box is closed. A
 * selected block formula is framed like a selected image, the frame around
 * its sideways scroller. The box itself is covered in
 * `document-math-box.test.tsx`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, t } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { blocksMarkdown } from '@web/spaces/document/document-table-markdown';

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

describe('rendering', () => {
  it('draws a formula block in display mode', async () => {
    const { root } = open([{ type: 'mathBlock', props: { source: '\\frac{a}{b}' } }]);
    expect(await appear(root, '.katex-display')).toBeTruthy();
  });

  it('scrolls a formula block sideways in a scroller of its own (§6.1)', async () => {
    const { root } = open([{ type: 'mathBlock', props: { source: '\\frac{a}{b}' } }]);
    const display = await appear(root, '.katex-display');
    const viewport = display.closest('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport!.closest('[data-scrollbars="horizontal"]')).not.toBeNull();
  });

  it('draws an inline formula in text mode', async () => {
    const { root } = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'E = mc^2' } }] }]);
    const katex = await appear(root, '.katex');
    expect(katex.closest('.katex-display')).toBeNull();
  });

  it('shows the placeholder for an empty formula', async () => {
    const { root } = open([{ type: 'mathBlock', props: { source: '' } }]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.empty'));
    });
  });

  // KaTeX draws nothing for white space, a comment or a lone style command,
  // so such a formula would have no width to see or press.
  it.each([
    ['an inline formula of white space', { type: 'paragraph', content: ['x ', { type: 'math', props: { source: '  ' } }, ' y'] }],
    ['a formula block of white space', { type: 'mathBlock', props: { source: ' \t\n ' } }],
    ['an inline formula holding only a comment', { type: 'paragraph', content: ['x ', { type: 'math', props: { source: '% todo' } }, ' y'] }],
    ['a formula block holding only a style command', { type: 'mathBlock', props: { source: '\\color{red}' } }],
    ['an inline formula holding only \\displaystyle', { type: 'paragraph', content: ['x ', { type: 'math', props: { source: '\\displaystyle' } }, ' y'] }],
  ])('shows the placeholder, to press, for %s, which KaTeX draws as nothing', async (_name, block) => {
    const { root } = open([block]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.empty'));
    });
    expect(root.querySelector('.doc-math [role="button"]')).not.toBeNull();
  });

  it('shows the error face for a source that does not parse, once closed', async () => {
    const { root } = open([{ type: 'mathBlock', props: { source: '\\frac{a}{b' } }]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.error'));
    });
  });
});

describe('a source KaTeX cannot finish', () => {
  /** Nested deep enough that KaTeX runs out of stack, not out of syntax. */
  const DEEP = `${'\\sqrt{'.repeat(1500)}x${'}'.repeat(1500)}`;

  it('shows the error face instead of taking the formula down', async () => {
    const { root } = open([{ type: 'mathBlock', props: { source: DEEP } }]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.error'));
    });
    expect(root.querySelector('.doc-math')).not.toBeNull();
  });

  it('still lets the body be read as Markdown', () => {
    const { editor } = open([{ type: 'mathBlock', props: { source: DEEP } }]);
    expect(() => blocksMarkdown(editor as never, editor.document as never)).not.toThrow();
  });
});

describe('a selected, closed formula block (§6.2)', () => {
  it('is marked selected, as a selected image is', async () => {
    const { editor, root } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: '\\frac{a}{b}' } },
    ]);
    const formula = await appear(root, '.doc-math');
    editor.setTextCursorPosition((editor.document as { id: string }[])[0]!.id, 'end');
    await vi.waitFor(() => {
      expect(formula.dataset['selected']).toBeUndefined();
    });

    editor.setTextCursorPosition((editor.document as { id: string }[])[1]!.id, 'end');

    await vi.waitFor(() => {
      expect(formula.dataset['selected']).toBe('true');
    });
    expect(root.querySelector('[data-formula-box]')).toBeNull();
  });

  it('draws the frame around the scroller, so a wide formula keeps all four sides', async () => {
    const { root } = open([{ type: 'mathBlock', props: { source: '\\frac{a}{b}' } }]);
    const display = await appear(root, '.katex-display');
    const frame = display.closest('[data-math-frame]');

    expect(frame).not.toBeNull();
    expect(frame!.querySelector('[data-radix-scroll-area-viewport]')).not.toBeNull();
  });

  it('drops the selected look when an undo takes the selection away', async () => {
    const { editor, root } = open([
      { type: 'paragraph', content: 'above' },
      { type: 'mathBlock', props: { source: 'x' } },
    ]);
    const formula = await appear(root, '.doc-math');
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'mathBlock') at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
    await vi.waitFor(() => {
      expect(formula.dataset['selected']).toBe('true');
    });

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)).setMeta('addToHistory', false));

    await vi.waitFor(() => {
      expect(formula.dataset['selected']).toBeUndefined();
    });
  });
});


describe('what a formula offers the pointer', () => {
  it('points the pointer at a formula the user can open, and not where the body is read-only', async () => {
    const { editor, root } = open([{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a' } }] }]);
    const face = await appear(root, '.doc-math [data-math-face]');
    expect(face.className).toContain('cursor-pointer');

    editor.isEditable = false;

    await vi.waitFor(() => {
      expect(face.className).toContain('cursor-default');
    });
    expect(face.className).not.toContain('cursor-pointer');
  });

  it('rounds the frame of a formula block that shows the placeholder or the error, as the grey face inside it is', async () => {
    const { root } = open([
      { type: 'mathBlock', props: { source: '' } },
      { type: 'mathBlock', props: { source: '\\frac{a' } },
      { type: 'mathBlock', props: { source: 'x' } },
    ]);
    await appear(root, '.katex-display');
    await vi.waitFor(() => {
      expect(root.querySelectorAll('[data-math-frame]')).toHaveLength(3);
    });
    const frames = [...root.querySelectorAll('[data-math-frame]')].map((frame) => frame.classList.contains('rounded-chrome'));

    expect(frames).toEqual([true, true, false]);
  });

  it('says an empty formula is empty, not something to add, where the body is read-only', async () => {
    const { editor, root } = open([{ type: 'mathBlock', props: { source: '' } }]);
    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.empty'));
    });

    editor.isEditable = false;

    await vi.waitFor(() => {
      expect(root.textContent).toContain(t('spaces.document.math.blank'));
    });
    expect(root.textContent).not.toContain(t('spaces.document.math.empty'));
  });
});
