// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the reader sees of where an answer came from.
 *
 * Two places. A marker sits where the claim it supports is written, and a row
 * at the foot of the reply lists every page the turn found -- including the
 * ones the model never cited, which is what three of the products that ship
 * this say their end list is for.
 *
 * A marker only becomes a chip when there is a source behind it. The model
 * writes these numbers itself, so `[7]` against three sources is a number it
 * invented; drawn as a chip it would be a chip that points nowhere, which is
 * the exact thing a citation is supposed to rule out.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatSource } from '@web/pages/project/chat/types';

/**
 * A source, as the panel holds it.
 * @param n - Distinguishes one from the next.
 * @returns The source.
 */
const source = (n: number): ChatSource => ({
  url: `https://s${String(n)}.example/page`,
  title: `Page ${String(n)}`,
  publisher: `Publisher${String(n)}`,
  index: n,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * Give jsdom the layout it has none of, for a row that measures itself.
 * @param root0 - The sizes to report.
 * @param root0.row - How wide the row is.
 * @param root0.item - How wide each thing in it is.
 */
function withLayout({ row, item }: { row: number; item: number }): void {
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const width = this.getAttribute('data-testid') === 'source-chip' ? item : row;
    return { ...real.call(this), width } as DOMRect;
  });
}

describe('a marker in the prose', () => {
  it('becomes a chip carrying the number it was written with', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'The silhouette comes from Victorian dress [1].',
          citations: { 1: source(1) },
        }}
      />,
    );

    const chip = screen.getByTestId('citation-chip');
    expect(chip).toHaveTextContent('1');
    expect(chip).toHaveAttribute('href', 'https://s1.example/page');
  });

  it('opens in a tab of its own, so the conversation is still there', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'A claim [1].',
          citations: { 1: source(1) },
        }}
      />,
    );

    expect(screen.getByTestId('citation-chip')).toHaveAttribute('target', '_blank');
  });

  it('takes several markers on one sentence', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'Two sources agree [1][2].',
          citations: { 1: source(1), 2: source(2) },
        }}
      />,
    );

    expect(screen.getAllByTestId('citation-chip')).toHaveLength(2);
  });

  it('leaves a number no source stands behind as the text it is', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'A claim [7].',
          citations: { 1: source(1) },
        }}
      />,
    );

    expect(screen.queryByTestId('citation-chip')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent('[7]');
  });

  it('leaves a link the model wrote alone', () => {
    // `[text](url)` is a link, and it happens to start the same way. Turning
    // its label into a chip would eat the link.
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'See [1](https://elsewhere.example).',
          citations: { 1: source(1) },
        }}
      />,
    );

    expect(screen.queryByTestId('citation-chip')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://elsewhere.example');
  });
});

describe('the row at the foot of the reply', () => {
  it('says what the row is before listing it', () => {
    // Publisher names alone are a line of proper nouns with nothing saying
    // what they have to do with the answer above them.
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'answer', sources: [source(1)] }}
      />,
    );

    expect(screen.getByTestId('source-row-label')).toBeInTheDocument();
  });

  it('names publishers rather than hosts', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'answer', sources: [source(1)] }}
      />,
    );

    expect(screen.getByTestId('source-row')).toHaveTextContent('Publisher1');
    expect(screen.getByTestId('source-row')).not.toHaveTextContent('s1.example');
  });

  it('opens a source in a tab of its own', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'answer', sources: [source(1)] }}
      />,
    );

    const chip = screen.getByTestId('source-chip');
    expect(chip).toHaveAttribute('href', 'https://s1.example/page');
    expect(chip).toHaveAttribute('target', '_blank');
  });

  it('opens a box listing every source when the row runs out of room', async () => {
    // 行放得下几个是量出来的，而 jsdom 没有布局：不喂宽度，每个元素都是 0 宽，
    // 于是永远「都放得下」，「+N」不出现。喂一个 296 的行和 100 宽的 chip，
    // 就是 Agent 列最窄时的样子。
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map(source);
    withLayout({ row: 296, item: 100 });
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer', sources: many }} />,
    );

    await userEvent.click(await screen.findByTestId('source-row-more'));

    const box = screen.getByTestId('source-box');
    expect(box).toBeInTheDocument();
    // Every one of them, including the ones the row had room for.
    expect(screen.getAllByTestId('source-box-row')).toHaveLength(8);
  });

  it('shows a title and a full address in the box, and no page text', () => {
    const withText = { ...source(1) } as ChatSource & { excerpts?: string[] };
    withText.excerpts = ['a passage of the page'];
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'answer', sources: [withText] }}
      />,
    );

    expect(screen.getByTestId('source-row')).not.toHaveTextContent('a passage of the page');
  });

  it('is absent on a turn that searched for nothing', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer' }} />);

    expect(screen.queryByTestId('source-row')).not.toBeInTheDocument();
  });

  it('is absent while the turn is still running', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'answer so far',
          streaming: true,
          sources: [source(1)],
        }}
      />,
    );

    expect(screen.queryByTestId('source-row')).not.toBeInTheDocument();
  });
});

describe('what the marker rewriting leaves alone', () => {
  it('keeps out of a formula, whose brackets are its own source', () => {
    // rehype-katex 先跑（MarkdownMessage.tsx:325），output 是 htmlAndMathml，
    // 所以树里有一个 <annotation> 装着模型写的 LaTeX 原文。把 [1] 换成一个
    // 引用块会改掉那段原文，而复制公式读的正是它。
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          // 单美元的行内公式是关掉的（MarkdownMessage.tsx:118），所以用双美元。
          content: '取第一项 $$P[1]$$ 即可。',
          citations: { 1: source(1) },
        }}
      />,
    );

    const annotation = document.querySelector('annotation');
    expect(annotation?.textContent ?? '').toContain('[1]');
    expect(annotation?.querySelector('citation-chip')).toBeNull();
  });
});
