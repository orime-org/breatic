// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a turn that found pictures, clips or audio puts on the reply.
 *
 * One row of squares, however many were found: the row does not wrap and does
 * not scroll, so what it cannot fit goes behind a button that opens all of
 * them. A square is a square whatever shape the thing inside it is -- a row of
 * differently-proportioned thumbnails reads as a mess rather than as a set.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import type { UIMessage } from 'ai';

/**
 * A finished `show_search_results` call, as the protocol carries it.
 * @param output - What the model handed the tool.
 * @returns The part.
 */
function shown(output: Record<string, unknown>): UIMessage['parts'][number] {
  return {
    type: 'tool-show_search_results',
    toolCallId: 'a',
    state: 'output-available',
    input: output,
    output,
  } as unknown as UIMessage['parts'][number];
}

afterEach(cleanup);

describe('reading the assets off a turn', () => {
  it('takes pictures, clips and audio, each knowing which it is', () => {
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [
        shown({
          images: [{ url: 'https://i.example/1.png', title: 'A picture' }],
          videos: [{ url: 'https://v.example/1.mp4', title: 'A clip', duration: '1:24' }],
          audios: [{ url: 'https://a.example/1.mp3', title: 'A track', duration: '0:30' }],
        }),
      ],
    } as UIMessage);

    expect(message.assets).toEqual([
      { kind: 'image', url: 'https://i.example/1.png', title: 'A picture' },
      { kind: 'video', url: 'https://v.example/1.mp4', title: 'A clip', duration: '1:24' },
      { kind: 'audio', url: 'https://a.example/1.mp3', title: 'A track', duration: '0:30' },
    ]);
  });

  it('leaves plain links out of the row, which is for things with a face', () => {
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [shown({ links: [{ url: 'https://p.example', title: 'A page' }] })],
    } as UIMessage);

    expect(message.assets).toBeUndefined();
  });
});

describe('the row of assets', () => {
  /**
   * A reply carrying that many pictures.
   * @param n - How many.
   * @returns The message.
   */
  const withImages = (n: number): Parameters<typeof MessageBubble>[0]['message'] => ({
    id: 'm',
    role: 'assistant',
    content: 'here they are',
    assets: Array.from({ length: n }, (_, i) => ({
      kind: 'image' as const,
      url: `https://i.example/${String(i)}.png`,
      title: `Picture ${String(i)}`,
    })),
  });

  it('draws each one as a square, cropped to fill it', () => {
    render(<MessageBubble message={withImages(1)} />);

    const image = screen.getByTestId('asset-thumb').querySelector('img');
    expect(image?.className).toContain('object-cover');
  });

  it('neither wraps nor scrolls, and puts the rest behind a button', async () => {
    render(<MessageBubble message={withImages(8)} />);

    const row = screen.getByTestId('asset-row');
    expect(row.className).not.toMatch(/flex-wrap|overflow-x-auto/);
    await userEvent.click(screen.getByTestId('asset-row-more'));
    expect(screen.getAllByTestId('asset-box-thumb').length).toBe(8);
  });

  it('marks how long a clip runs, which a still frame cannot say', () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'a clip',
          assets: [
            { kind: 'video', url: 'https://v.example/1.mp4', title: 'A clip', duration: '1:24' },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('asset-thumb')).toHaveTextContent('1:24');
  });

  it('gives audio a face of its own, and its name and length in the box', async () => {
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'a track',
          assets: [
            { kind: 'audio', url: 'https://a.example/1.mp3', title: 'A track', duration: '0:30' },
          ],
        }}
      />,
    );

    // 46 见方的格子只放得下一个「这是什么」的图标 —— 名字和时长在打开后的
    // 框里，那儿才有地方读。名字仍在无障碍名上，读屏用户不受影响。
    const thumb = screen.getByTestId('asset-thumb');
    expect(thumb).toHaveAttribute('aria-label', 'A track');

    await userEvent.click(thumb);

    const box = screen.getByTestId('asset-box');
    expect(box).toHaveTextContent('A track');
    expect(box).toHaveTextContent('0:30');
  });

  it('opens one for a proper look, with the rest along the bottom', async () => {
    render(<MessageBubble message={withImages(3)} />);

    await userEvent.click(screen.getAllByTestId('asset-thumb')[0]!);

    expect(screen.getByTestId('asset-box')).toBeInTheDocument();
    expect(screen.getAllByTestId('asset-box-thumb')).toHaveLength(3);
    expect(screen.getAllByTestId('asset-box-thumb')[0]).toHaveAttribute('aria-current', 'true');
  });

  it('opens at the first one behind the button, not back at the start', async () => {
    render(<MessageBubble message={withImages(8)} />);

    const drawn = screen.getAllByTestId('asset-thumb').length;
    await userEvent.click(screen.getByTestId('asset-row-more'));

    expect(screen.getAllByTestId('asset-box-thumb')[drawn]).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('is absent on a turn that found none', () => {
    render(<MessageBubble message={{ id: 'm', role: 'assistant', content: 'answer' }} />);

    expect(screen.queryByTestId('asset-row')).not.toBeInTheDocument();
  });
});

describe('getting the reader back where they were', () => {
  /**
   * A reply carrying that many pictures.
   * @param n - How many.
   * @returns The message.
   */
  const withImages = (n: number): Parameters<typeof MessageBubble>[0]['message'] => ({
    id: 'm',
    role: 'assistant',
    content: 'here they are',
    assets: Array.from({ length: n }, (_, i) => ({
      kind: 'image' as const,
      url: `https://i.example/${String(i)}.png`,
      title: `Picture ${String(i)}`,
    })),
  });

  // 框是从状态开的，不是从 Radix 的 Trigger 开的，而 Radix 的 dialog 关闭时
  // 只把焦点交给 triggerRef（@radix-ui/react-dialog@1.1.23 dist/index.mjs:154）。
  // 没有 trigger 就没人接，键盘用户按完 Escape 焦点落到 body，要从头 Tab 回来。
  it('puts focus back on the square that opened the box', async () => {
    render(<MessageBubble message={withImages(3)} />);
    const thumb = screen.getAllByTestId('asset-thumb')[0]!;
    thumb.focus();

    await userEvent.click(thumb);
    expect(screen.getByTestId('asset-box')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('asset-box')).toBeNull());
    expect(document.activeElement).toBe(thumb);
  });

  it('puts focus back on the button when the box was opened from it', async () => {
    render(<MessageBubble message={withImages(20)} />);
    const more = screen.getByTestId('asset-row-more');
    more.focus();

    await userEvent.click(more);
    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByTestId('asset-box')).toBeNull());
    expect(document.activeElement).toBe(more);
  });
});

describe('what a square draws', () => {
  it('gives a clip an icon rather than an image its address cannot fill', () => {
    // `show_search_results` 的 url 描述是「Direct URL to the asset / page」，
    // 视频那个字段给的是片子或它的页面，不是一张图。塞进 <img> 就是一个空格子
    // 加一个飘在虚空上的时长。
    render(
      <MessageBubble
        message={{
          id: 'm',
          role: 'assistant',
          content: 'a clip',
          assets: [
            { kind: 'video', url: 'https://v.example/1.mp4', title: 'A clip', duration: '1:24' },
          ],
        }}
      />,
    );

    const thumb = screen.getByTestId('asset-thumb');
    expect(thumb.querySelector('img')).toBeNull();
    expect(thumb).toHaveTextContent('1:24');
  });
});
