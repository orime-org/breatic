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
