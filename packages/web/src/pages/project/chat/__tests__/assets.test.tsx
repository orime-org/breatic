// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a turn that found pictures puts on the reply.
 *
 * One row of squares, however many were found: the row does not wrap and does
 * not scroll, so what it cannot fit goes behind a button that opens all of
 * them. A square is a square whatever shape the picture is -- a row of
 * differently-proportioned thumbnails reads as a mess rather than as a set.
 *
 * Every square, and the open view too, is drawn from the thumbnail address.
 * The original is carried alongside it and nothing draws from it: it is the
 * file, hosted by whoever published it, and this row is a view.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import { toChatMessage } from '@web/pages/project/chat/to-chat-message';
import type { UIMessage } from 'ai';

/**
 * A finished `search_images` call, as the protocol carries it.
 * @param output - What the tool answered with.
 * @returns The part.
 */
function shown(output: Record<string, unknown>): UIMessage['parts'][number] {
  return {
    type: 'tool-search_images',
    toolCallId: 'a',
    state: 'output-available',
    input: output,
    output,
  } as unknown as UIMessage['parts'][number];
}

afterEach(cleanup);

describe('reading the assets off a turn', () => {
  it('keeps both addresses and the page each was found on', () => {
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [
        shown({
          images: [
            {
              thumbnailUrl: 'https://thumb.example/1.jpg',
              imageUrl: 'https://i.example/1.png',
              pageUrl: 'https://page.example/1',
              title: 'A picture',
            },
          ],
        }),
      ],
    } as UIMessage);

    expect(message.assets).toEqual([
      {
        thumbnailUrl: 'https://thumb.example/1.jpg',
        imageUrl: 'https://i.example/1.png',
        pageUrl: 'https://page.example/1',
        title: 'A picture',
      },
    ]);
  });

  it('keeps an entry that carries only the address a square is drawn from', () => {
    // The square needs the thumbnail and nothing else. An entry the service
    // said less about than usual is still a picture the row can draw.
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [
        shown({
          images: [{ thumbnailUrl: 'https://thumb.example/1.jpg', title: 'Half an entry' }],
        }),
      ],
    } as UIMessage);

    expect(message.assets).toHaveLength(1);
    expect(message.assets?.[0]?.thumbnailUrl).toBe('https://thumb.example/1.jpg');
  });

  it('leaves out an entry with no thumbnail, rather than drawing a blank square', () => {
    // A row stored before this tool existed carries something else entirely,
    // and a call that failed carries nothing. Reading a field off either
    // throws while the message is being built, which takes the whole
    // conversation down rather than one row.
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [shown({ images: [{ imageUrl: 'https://i.example/1.png', title: 'No thumbnail' }] })],
    } as UIMessage);

    expect(message.assets).toBeUndefined();
  });

  it('leaves out an entry whose thumbnail is an empty string', () => {
    // Same ending as no address at all, by a different route: the square is
    // drawn from this field, and an empty one draws nothing while holding its
    // place in the row. The tool drops these before they are stored, so this
    // is the panel's own half of a guard written on both sides.
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [shown({ images: [{ thumbnailUrl: '', title: 'Empty address' }] })],
    } as UIMessage);

    expect(message.assets).toBeUndefined();
  });

  it('gives an entry with no title an empty one rather than passing undefined on', () => {
    // `title` reaches the square's label and the open box's header. Absent, it
    // reads there as the word "undefined".
    const message = toChatMessage({
      id: 'm',
      role: 'assistant',
      parts: [shown({ images: [{ thumbnailUrl: 'https://thumb.example/1.jpg' }] })],
    } as UIMessage);

    expect(message.assets?.[0]?.title).toBe('');
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
      thumbnailUrl: `https://thumb.example/${String(i)}.jpg`,
      imageUrl: `https://i.example/${String(i)}.png`,
      pageUrl: `https://page.example/${String(i)}`,
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

  it('opens one for a proper look, with the rest along the bottom', async () => {
    render(<MessageBubble message={withImages(3)} />);

    await userEvent.click(screen.getAllByTestId('asset-thumb')[0]!);

    expect(screen.getByTestId('asset-box')).toBeInTheDocument();
    expect(screen.getAllByTestId('asset-box-thumb')).toHaveLength(3);
    expect(screen.getAllByTestId('asset-box-thumb')[0]).toHaveAttribute('aria-current', 'true');
  });

  it('is the same size whatever the column around it is doing', async () => {
    // The box a reply opens stands on its own: user 2026-09-05 settled that it
    // is not laid out against the agent column, so nothing about the column
    // reaches its geometry.
    render(<MessageBubble message={withImages(3)} />);

    await userEvent.click(screen.getAllByTestId('asset-thumb')[0]!);

    const box = screen.getByTestId('asset-box');
    expect(box.className).toMatch(/w-\[520px\]/);
    expect(box.className).toMatch(/h-\[560px\]/);
    expect(box.className).not.toMatch(/inset-4/);
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
      thumbnailUrl: `https://thumb.example/${String(i)}.jpg`,
      imageUrl: `https://i.example/${String(i)}.png`,
      pageUrl: `https://page.example/${String(i)}`,
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

describe('which address a square is drawn from', () => {
  /**
   * One picture, whose two addresses are told apart by their host.
   * @returns The message.
   */
  const onePicture = (): Parameters<typeof MessageBubble>[0]['message'] => ({
    id: 'm',
    role: 'assistant',
    content: 'here it is',
    assets: [
      {
        thumbnailUrl: 'https://thumb.example/1.jpg',
        imageUrl: 'https://original.example/1.png',
        pageUrl: 'https://page.example/1',
        title: 'A picture',
      },
    ],
  });

  it('draws the square from the thumbnail', () => {
    // The original is whatever the site that published it hosts -- full size,
    // and reached over a connection nothing here controls. A row of them is a
    // row of full-size downloads to fill 46 pixels.
    render(<MessageBubble message={onePicture()} />);

    const image = screen.getByTestId('asset-thumb').querySelector('img');
    expect(image).toHaveAttribute('src', 'https://thumb.example/1.jpg');
  });

  it('draws the open view from the thumbnail too', async () => {
    // user 2026-09-11: "前端整个来讲都是用缩略图的 URL". Opening one is still
    // the frontend, so it shows the 500px wide copy rather than the original.
    render(<MessageBubble message={onePicture()} />);

    await userEvent.click(screen.getByTestId('asset-thumb'));

    const box = screen.getByTestId('asset-box');
    const stage = box.querySelector('img[alt="A picture"]');
    expect(stage).toHaveAttribute('src', 'https://thumb.example/1.jpg');

    // The strip along the bottom is drawn from the same address. It holds
    // every picture at once, so an original there is N full-size downloads.
    for (const img of box.querySelectorAll('[data-testid="asset-box-thumb"] img')) {
      expect(img).toHaveAttribute('src', 'https://thumb.example/1.jpg');
    }
  });
});
