// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the reader sees of where an answer came from.
 *
 * Two places. A marker sits where the claim it supports is written, and the
 * line under the reply says how many pages the turn found -- including the
 * ones the model never cited, which is what three of the products that ship
 * this say their end list is for. The list itself is behind that count.
 *
 * A marker only becomes a ring when there is a source behind it. The model
 * writes these numbers itself, so `[7]` against three sources is a number it
 * invented; drawn as a ring it would be a ring that points nowhere, which is
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
  indexes: [n],
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a marker in the prose', () => {
  it('is a circle carrying the number it was written with, and nothing else', () => {
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
    expect(chip.className).toMatch(/rounded-full/);
    expect(chip.textContent).toBe('1');
    expect(chip.querySelector('[aria-hidden]')).toBeNull();
  });

  it('sits on the baseline of the line it is written in', () => {
    // Held 3px below it, the ring's underside cleared the text's by 4px while
    // the gap between two lines is 5.95px -- the marker took more than half of
    // it and read as hanging between the lines rather than set in the sentence.
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

    expect(screen.getByTestId('citation-chip').className).not.toMatch(/\balign-\[/);
  });

  it('keeps a gap between itself and the words on either side', () => {
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

    // Substituted in place, with nothing added around it, so the ring sits
    // against the character before it and the full stop after it.
    expect(screen.getByTestId('citation-chip').className).toMatch(/\bml-\[2px\]/);
    expect(screen.getByTestId('citation-chip').className).toMatch(/\bmr-px\b/);
  });

  it('is one size whatever number it carries', () => {
    // Widening with the number pushes whatever follows it: in the box the
    // titles line up under each other, and the one row cited past nine sat
    // 4.58px to the right of the other nine.
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'One [1]. Ten [10].',
          citations: { 1: source(1), 10: source(10) },
        }}
      />,
    );

    const [one, ten] = screen.getAllByTestId('citation-chip');
    expect(one?.className).toMatch(/\bsize-4\b/);
    expect(one?.className).toBe(ten?.className);
    expect(one?.className).not.toMatch(/min-w-|\bpx-/);
  });

  it('draws its own focus ring rather than leaving one to the browser', () => {
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

    // The browser's is 2px and carries an offset; every hand-written control
    // in this app draws a 1px ring against its own edge.
    expect(screen.getByTestId('citation-chip').className).toMatch(/focus-visible:ring-1/);
  });

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

describe('the line at the foot of the reply', () => {
  it('offers copy first and the sources after it', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'answer', sources: [source(1)] }}
      />,
    );

    const copy = screen.getByTestId('turn-copy');
    const sources = screen.getByTestId('turn-sources');
    const after = copy.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after).toBeTruthy();
  });

  it('says how many there are and lists none of them', () => {
    const many = [1, 2, 3, 4, 5].map(source);
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer', sources: many }} />,
    );

    expect(screen.getByTestId('turn-sources')).toHaveTextContent('5');
    // 两条都查整个 body：框走 Dialog 的 Portal，挂在 turn-actions 外面，
    // 只在这一行的子树里找等于什么都没查。
    expect(screen.queryByTestId('source-box')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('source-box-row')).toHaveLength(0);
  });

  it('lists them once it is pressed, each with the number it was cited by', async () => {
    const many = [1, 2, 3, 4, 5].map(source);
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer', sources: many }} />,
    );

    await userEvent.click(screen.getByTestId('turn-sources'));

    expect(screen.getByTestId('source-box')).toBeInTheDocument();
    const rows = screen.getAllByTestId('source-box-row');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('1');
    expect(rows[0]).toHaveTextContent('Page 1');
    expect(rows[0]).toHaveTextContent('https://s1.example/page');
  });

  it('draws its own focus ring on each row of the box', async () => {
    // Every row is the only thing in that dialog a keyboard can reach.
    const many = [1, 2].map(source);
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer', sources: many }} />,
    );

    await userEvent.click(screen.getByTestId('turn-sources'));

    for (const row of screen.getAllByTestId('source-box-row')) {
      expect(row.className).toMatch(/focus-visible:ring-1/);
    }
  });

  it('lines the titles up under each other whatever numbers the rows carry', async () => {
    // Nine rows aligned and the tenth 4.58px to the right of them is what a
    // ring that widens with its number does to the column beside it.
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'answer',
          sources: [source(9), source(10)],
        }}
      />,
    );

    await userEvent.click(screen.getByTestId('turn-sources'));

    for (const marks of screen.getAllByTestId('source-box-marks')) {
      const ring = marks.firstElementChild;
      expect(ring?.className).toMatch(/\bsize-4\b/);
      expect(ring?.className).not.toMatch(/min-w-|\bpx-/);
    }
  });

  it('draws no publisher and no mark of the site anywhere', () => {
    // 一个站点图形要显示就得去第三方取图，那次请求把读者交给了第三方；
    // 圆圈里只有数字，所以这条路整条不存在。
    const many = [1, 2].map(source);
    render(
      <MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer', sources: many }} />,
    );

    expect(screen.getByTestId('turn-actions')).not.toHaveTextContent('Publisher1');
    expect(document.querySelector('[class*="bg-palette"]')).toBeNull();
  });

  it('keeps the line on a turn that found sources and said nothing', () => {
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: '', sources: [source(1)] }}
      />,
    );

    expect(screen.getByTestId('turn-sources')).toBeInTheDocument();
  });

  it('offers no sources on a turn that searched for nothing', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer' }} />);

    expect(screen.queryByTestId('turn-sources')).not.toBeInTheDocument();
    expect(screen.getByTestId('turn-copy')).toBeInTheDocument();
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

    expect(screen.queryByTestId('turn-sources')).not.toBeInTheDocument();
  });

  it('shows no page text in the box', async () => {
    const withText = { ...source(1) } as ChatSource & { excerpts?: string[] };
    withText.excerpts = ['a passage of the page'];
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'answer', sources: [withText] }}
      />,
    );

    // 框走 Dialog 的 Portal 挂在 body 上，不在这一行的子树里，所以要先点开
    // 再对框本身断言。
    await userEvent.click(screen.getByTestId('turn-sources'));

    expect(await screen.findByTestId('source-box')).not.toHaveTextContent(
      'a passage of the page',
    );
  });

  it('lists every number a page was cited by, so a marker can be found here', async () => {
    // 一轮里两次搜索命中同一个网址，那个网址领到两个号；正文里两个号都会
    // 渲染成圈，所以框里要两个都认。
    const twice: ChatSource = { ...source(1), indexes: [5] };
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'A claim [1], and again [5].',
          sources: [{ ...source(1), indexes: [1, 5] }],
          citations: { 1: source(1), 5: twice },
        }}
      />,
    );

    await userEvent.click(screen.getByTestId('turn-sources'));

    const row = (await screen.findAllByTestId('source-box-row'))[0];
    const marks = row?.querySelector('[data-testid="source-box-marks"]');
    // 一页的几个号是一组，跟标题是另一件事：并排摊在行里，读者看到的是
    // 三个平权的东西。
    expect(marks?.textContent).toBe('15');
    expect(row?.children.length).toBe(2);
  });

  it('offers no copy on a turn that wrote nothing', () => {
    // 那一行是为了留住「来源 N」才画的；把空字符串放进剪贴板会顶掉读者
    // 原来复制的东西，而界面还说复制成功了。
    render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: '', sources: [source(1)] }}
      />,
    );

    expect(screen.getByTestId('turn-sources')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-copy')).not.toBeInTheDocument();
  });
});

describe('a reply still arriving', () => {
  it('keeps the same marker node when a fresh reply object comes in', () => {
    // 流式期间每 50ms 都是一个新的 citations 对象。渲染器认组件身份，身份一变
    // 整棵子树重建：悬停卡的开启计时器跟着没，划到一半的选区也塌掉。
    const first = { 1: source(1) };
    const { rerender } = render(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'A claim [1].', citations: first, streaming: true }}
      />,
    );
    const before = screen.getByTestId('citation-chip');

    rerender(
      <MessageBubble
        message={{ id: 'm', role: 'assistant', content: 'A claim [1] and more.', citations: { 1: source(1) }, streaming: true }}
      />,
    );

    expect(screen.getByTestId('citation-chip')).toBe(before);
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
