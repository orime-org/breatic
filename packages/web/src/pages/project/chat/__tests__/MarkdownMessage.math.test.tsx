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

/** What a copy left behind: the flavours written, and the event itself. */
interface Copied {
  written: Map<string, string>;
  event: Event;
}

/**
 * Copies what these ranges cover, the way a keystroke would.
 * @param ranges - What the reader has selected. Several stand in for Gecko,
 *   which is the one engine that makes more than one out of a ctrl-drag —
 *   neither jsdom nor Blink will hold a second.
 * @returns What reached the clipboard, and the event that carried it.
 */
function copy(...ranges: Range[]): Copied {
  const selection = window.getSelection();
  const held = {
    isCollapsed: false,
    rangeCount: ranges.length,
    getRangeAt: (index: number): Range => ranges[index] as Range,
  } as unknown as Selection;
  const realSelection = window.getSelection.bind(window);
  window.getSelection = (): Selection => held;

  const written = new Map<string, string>();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (type: string, data: string): Map<string, string> => written.set(type, data),
    },
  });
  document.dispatchEvent(event);

  window.getSelection = realSelection;
  selection?.removeAllRanges();
  return { written, event };
}

/**
 * The range covering everything inside this element.
 * @param node - What to select.
 * @returns The range.
 */
function around(node: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range;
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
    const { written, event } = copy(around(body as Element));

    // The browser derives the plain-text flavour from what it has laid out,
    // which jsdom has none of — `innerText` is undefined here. What both
    // flavours are built from is the same fragment, so this asserts on the
    // markup; §6.1 of the design carries the browser's own plain text.
    const html = written.get('text/html') ?? '';
    // The source as the model wrote it, delimiters and line breaks included,
    // so a copied reply pastes back as the same reply.
    expect(html, 'the copy carries the LaTeX the model wrote').toContain('$$\nE = mc^2\n$$');
    expect(html.match(/E = mc\^2/g) ?? [], 'and carries it once').toHaveLength(1);
    expect(html, 'and carries nothing the reader cannot see').not.toContain('scrollbar-width');
    // What is written only reaches the clipboard if the browser's own copy is
    // stopped, and its own is the three-times-over one this replaces.
    expect(event.defaultPrevented, 'and the browser writes nothing over it').toBe(true);
  });

  it('leaves a copy with no formula in it to the browser (A8)', () => {
    // This handler is on the document, so every copy anywhere in the app comes
    // through it. A reply with no formula has nothing for it to do, and the
    // browser is what copies the rest of this product.
    const body = draw('An answer with no formula in it.').querySelector(
      '[data-testid="markdown-body"]',
    );

    const { written, event } = copy(around(body as Element));

    expect(written.size, 'nothing is written').toBe(0);
    expect(event.defaultPrevented, 'and the browser is left to it').toBe(false);
  });

  it('leaves markup in a reply inert on the clipboard (A8)', () => {
    // The pipeline renders no inline HTML, so this reaches the reader as
    // characters. Building the markup flavour by hand would hand it on as
    // live markup instead — the browser escapes what it serialises.
    const body = draw('A tag <img src=x onerror=alert(1)> and $$x$$ after.').querySelector(
      '[data-testid="markdown-body"]',
    );
    const paragraph = body?.querySelector('p');
    const range = document.createRange();
    // Started part-way through, the way a drag does, so the copy holds loose
    // text as well as elements.
    range.setStart(paragraph?.firstChild as Node, 2);
    range.setEndAfter(paragraph?.lastChild as Node);

    const html = copy(range).written.get('text/html') ?? '';
    expect(html, 'the tag is still characters').toContain('&lt;img');
    expect(html, 'and not markup').not.toContain('<img');
  });

  // KaTeX writes `white-space: nowrap` on a display formula and offers no
  // overflow of its own, and the list around the reply only scrolls
  // vertically — so a formula wider than the 320px column is cut off with
  // nothing to drag. Wide tables reach a ScrollArea for the same reason.
  // A model deriving something writes formulas inside quotes and numbered
  // steps as readily as at the top, and those reach the scroller by a
  // different line of the plugin.
  it.each([
    ['on its own', '$$\nx = 1\n$$'],
    ['inside a quote', '> $$\n> x = 1\n> $$'],
    ['inside a list item', '- step\n\n  $$\n  x = 1\n  $$'],
  ])('hands a display formula %s its own horizontal scroller (A7)', (_where, content) => {
    draw(content);

    const display = screen.getByTestId('markdown-body').querySelector('.katex-display');
    expect(display, 'the formula is rendered at all').not.toBeNull();
    expect(
      display?.closest('[data-scrollbars="horizontal"]') ?? null,
      'a display formula sits inside a horizontal ScrollArea',
    ).not.toBeNull();
  });

  it('copies a formula selected on its own as one on its own line (A8)', () => {
    // The most direct way to copy a formula is to drag across it, and both
    // ends of that drag are inside it. What is cloned is the formula, not the
    // block it sits in — so whether it stands on its own has to be read off
    // the formula.
    const body = draw('$$\nE = mc^2\n$$').querySelector('[data-testid="markdown-body"]');
    const formula = body?.querySelector('.katex') as Element;
    const range = document.createRange();
    range.setStartBefore(formula);
    range.setEndAfter(formula);

    expect(copy(range).written.get('text/html') ?? '').toContain('$$\nE = mc^2\n$$');
  });

  it('copies every part of a selection that holds more than one (A8)', () => {
    const body = draw('one\n\ntwo\n\n$$\nx = 1\n$$').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const parts = [...body.querySelectorAll('p'), body.querySelector('.katex') as Element];

    const html = copy(...parts.map(around)).written.get('text/html') ?? '';

    expect(html, 'the first range is there').toContain('one');
    expect(html, 'and so is the second').toContain('two');
    expect(html, 'and the formula').toContain('x = 1');
  });

  it('keeps a copied table a table (A8)', () => {
    // What a drag hands over is what sits under the two ends' common
    // ancestor, never the ancestor — so a drag across cells hands over rows
    // with no table around them, and every parser drops a row it finds
    // outside one.
    const body = draw('| a | b |\n|---|---|\n| $$x^2$$ | beta |\n| gamma | delta |').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const cells = [...body.querySelectorAll('td')];
    const range = document.createRange();
    range.setStart(cells[0] as Node, 0);
    const last = cells[cells.length - 1] as Node;
    range.setEnd(last, last.childNodes.length);

    const html = copy(range).written.get('text/html') ?? '';

    const reparsed = document.createElement('div');
    reparsed.innerHTML = html;
    expect(reparsed.querySelector('table'), 'a paste target still sees a table').not.toBeNull();
    expect(reparsed.querySelectorAll('td').length, 'with its cells').toBeGreaterThan(1);
  });

  it('keeps a copied numbered list numbered (A8)', () => {
    const body = draw('1. first $$x^2$$\n2. second\n3. third').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const items = [...body.querySelectorAll('li')];
    const range = document.createRange();
    range.setStart(items[0] as Node, 0);
    const last = items[items.length - 1] as Node;
    range.setEnd(last, last.childNodes.length);

    const html = copy(range).written.get('text/html') ?? '';

    const reparsed = document.createElement('div');
    reparsed.innerHTML = html;
    expect(reparsed.querySelector('ol'), 'a paste target still sees the numbering').not.toBeNull();
  });

  it('hands over half a sentence as half a sentence (A8)', () => {
    // Wrapping this back up would make a block of it, and it is a piece of
    // one line.
    const body = draw('before $$x^2$$ after the formula').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const paragraph = body.querySelector('p') as Element;
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Node, 3);
    range.setEndAfter(paragraph.lastChild as Node);

    const html = copy(range).written.get('text/html') ?? '';

    expect(html, 'no block is put around it').not.toContain('<p>');
    expect(html, 'and the formula is its source').toContain('$$x^2$$');
  });

  it('gives back the whole formula when a drag starts inside one (A8)', () => {
    // The start of the drag is a glyph in the middle of the rendered
    // formula; what the reader meant is the formula.
    const body = draw('before $$E = mc^2$$ after').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const glyphs = body.querySelector('.katex-html') as Element;
    const paragraph = body.querySelector('p') as Element;
    const range = document.createRange();
    range.setStart(glyphs, 1);
    range.setEndAfter(paragraph.lastChild as Node);

    const html = copy(range).written.get('text/html') ?? '';

    expect(html, 'the source is there whole').toContain('$$E = mc^2$$');
    expect(html, 'not an empty pair of delimiters').not.toContain('$$$$');
  });

  it('keeps two ranges the reader picked apart apart (A8)', () => {
    // What a drag hands over is the words inside a paragraph, not the
    // paragraph — so two of them appended one after the other read as one
    // run-on line, and the browser's own copy puts them on separate lines.
    const body = draw('first para with $$x=1$$ inside\n\nsecond para\n\nthird para').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const paragraphs = [...body.querySelectorAll('p')];

    const html = copy(around(paragraphs[0] as Node), around(paragraphs[2] as Node)).written.get(
      'text/html',
    ) ?? '';

    expect(html, 'the first is there').toContain('first para');
    expect(html, 'and the third').toContain('third para');
    expect(html, 'and they are not run together').not.toContain('insidethird');
  });

  it('copies a formula two ranges both reach into only once (A8)', () => {
    // Two ctrl-drags that cut through the same formula leave two ranges the
    // reader drew as disjoint. Each is widened to the whole formula, and the
    // widening is what makes them overlap.
    const body = draw('before $$E = mc^2$$ after').querySelector(
      '[data-testid="markdown-body"]',
    ) as Element;
    const paragraph = body.querySelector('p') as Element;
    const formula = body.querySelector('.katex') as Element;
    const glyphs = formula.querySelector('.katex-html') as Element;

    const first = document.createRange();
    first.setStart(paragraph.firstChild as Node, 0);
    first.setEnd(glyphs, 0);
    const second = document.createRange();
    second.setStart(glyphs, glyphs.childNodes.length);
    second.setEndAfter(paragraph.lastChild as Node);

    const html = copy(first, second).written.get('text/html') ?? '';

    expect(html, 'the formula is there').toContain('$$E = mc^2$$');
    expect(html.match(/E = mc\^2/g) ?? [], 'once').toHaveLength(1);
  });
});
