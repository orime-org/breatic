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
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { squaresThatFit } from '@web/pages/project/chat/AssetRow';
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

  it('gives audio a face of its own, with its name and how long it runs', () => {
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

    const thumb = screen.getByTestId('asset-thumb');
    expect(thumb).toHaveTextContent('A track');
    expect(thumb).toHaveTextContent('0:30');
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

describe('how many squares a row of that width holds', () => {
  // 96 见方加 8 的间距，而 Agent 列从 320 拖到 640、消息列表两边各 12 的内边距
  // —— 所以行宽是 296 到 616。数不对的后果不是排版难看：行是 overflow-hidden 的，
  // 放不下的那些连同「+N」按钮一起被裁掉，屏幕上不留任何痕迹。
  it('draws them all when they all fit, with no button to make room for', () => {
    expect(squaresThatFit(616, 5)).toBe(5);
  });

  it('gives up one square to the button when they do not', () => {
    // 616 装得下 6 个（96×6 + 8×5 = 616），第 6 格让给按钮。
    expect(squaresThatFit(616, 9)).toBe(5);
  });

  it('still draws one at the narrowest the column goes', () => {
    // 296 只装得下 2 个，减去按钮剩 1 —— 少到不能再少，但不是零。
    expect(squaresThatFit(296, 8)).toBe(1);
    expect(squaresThatFit(296, 2)).toBe(2);
  });
});
