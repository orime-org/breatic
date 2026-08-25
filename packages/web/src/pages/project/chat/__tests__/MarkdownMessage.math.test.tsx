// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Maths in an assistant reply.
 *
 * The delimiter split follows what remark-math does on its own: `$$` on lines
 * of their own is a display formula, `$$…$$` inside a sentence is inline, and a
 * lone `$` is a character (user 2026-08-25 — a price is written far more often
 * than a formula, and `$$…$$` already expresses an inline one).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MarkdownMessage } from '@web/pages/project/chat/MarkdownMessage';

/**
 * Renders one settled assistant reply.
 * @param content - The markdown to draw.
 * @returns The rendered container.
 */
function draw(content: string): HTMLElement {
  return render(<MarkdownMessage content={content} />).container;
}

describe('MarkdownMessage — maths', () => {
  it('gives a formula on its own lines a line of its own (A1)', () => {
    draw('$$\nx = 1\n$$');

    expect(screen.getByTestId('markdown-body').querySelector('.katex-display')).not.toBeNull();
  });

  it('keeps a formula written inside a sentence in the sentence (A2)', () => {
    draw('爱因斯坦说 $$E = mc^2$$ 就这样。');

    const body = screen.getByTestId('markdown-body');
    expect(body.querySelector('.katex')).not.toBeNull();
    expect(body.querySelector('.katex-display')).toBeNull();
    expect(body.textContent).toContain('爱因斯坦说');
    expect(body.textContent).toContain('就这样');
  });

  it('leaves a lone dollar as a character (A3)', () => {
    draw('It costs $5 today and $10 tomorrow.');

    const body = screen.getByTestId('markdown-body');
    expect(body.querySelector('.katex')).toBeNull();
    expect(body.textContent).toBe('It costs $5 today and $10 tomorrow.');
  });

  it('leaves a dollar inside inline code alone (A4)', () => {
    draw('Run `echo $HOME` to see it.');

    const code = screen.getByTestId('markdown-body').querySelector('code');
    expect(code?.textContent).toBe('echo $HOME');
  });

  it('leaves a dollar inside a fenced block alone (A4)', () => {
    draw('```bash\necho $HOME\n```');

    expect(screen.getByTestId('markdown-body').querySelector('pre')?.textContent).toContain(
      'echo $HOME',
    );
  });

  it('falls back to readable text when the formula is broken (A6)', () => {
    // A reply that stopped mid-formula and one the model got wrong reach this
    // same class, and the code cannot tell them apart — so it stays quiet.
    draw('试试 $$\\frac{$$ 这个。');

    const bad = screen.getByTestId('markdown-body').querySelector('.katex-error');
    expect(bad).not.toBeNull();
    expect(bad?.getAttribute('style')).toContain('--color-muted-foreground');
    expect(bad?.getAttribute('title')).toBeTruthy();
    expect(bad?.textContent).toBe('\\frac{');
  });

  it('gives a copier the formula source, once (A8)', () => {
    // KaTeX draws a formula three times over: MathML for a screen reader, the
    // LaTeX it came from, and the glyphs. Measured in Chrome, a selection
    // across a formula serialises two of the three, so a reader copying a
    // reply gets the formula twice and neither copy is readable.
    const body = draw('$$\nE = mc^2\n$$').querySelector('[data-testid="markdown-body"]');
    expect(body?.querySelector('.katex-display'), 'the formula is rendered at all').not.toBeNull();

    // Selected the way a reader drags across a whole reply, which takes in the
    // scroller around the formula — and Radix gives each scroller a `style`
    // element of its own, which the browser never renders and a reader must
    // never be handed.
    const range = document.createRange();
    range.selectNodeContents(body as Element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const written = new Map<string, string>();
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(copy, 'clipboardData', {
      value: {
        setData: (type: string, data: string): Map<string, string> => written.set(type, data),
      },
    });
    document.dispatchEvent(copy);

    const plain = written.get('text/plain') ?? '';
    // The source as the model wrote it, delimiters and line breaks included,
    // so a copied reply pastes back as the same reply.
    expect(plain, 'the copy carries the LaTeX the model wrote').toContain('$$\nE = mc^2\n$$');
    expect(plain.match(/E = mc\^2/g) ?? [], 'and carries it once').toHaveLength(1);
    expect(plain, 'and carries nothing the reader cannot see').not.toContain('scrollbar-width');
  });

  it('hands a display formula its own horizontal scroller (A7)', () => {
    // KaTeX writes `white-space: nowrap` on a display formula and offers no
    // overflow of its own, and the list around the reply only scrolls
    // vertically — so a formula wider than the 320px column is cut off with
    // nothing to drag. Wide tables reach a ScrollArea for the same reason.
    draw('$$\nx = 1\n$$');

    const display = screen.getByTestId('markdown-body').querySelector('.katex-display');
    expect(display, 'the formula is rendered at all').not.toBeNull();
    expect(
      display?.closest('[data-scrollbars="horizontal"]') ?? null,
      'a display formula sits inside a horizontal ScrollArea',
    ).not.toBeNull();
  });
});
