// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying a found picture so it can be pasted onto the canvas.
 *
 * The copy writes the canvas's own clipboard text: one image node whose
 * content is the picture's thumbnail address, flagged as outside our storage so
 * the canvas fetches it into storage on paste.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import { clipboardTextFor } from '@web/pages/project/chat/copy-asset';
import { parseClipboardNodes } from '@web/spaces/canvas/node-clipboard';
import type { ChatAsset } from '@web/pages/project/chat/types';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@web/lib/toast', () => ({ toast: { error: toastError } }));

afterEach(cleanup);

describe('what a copy puts on the clipboard', () => {
  const asset = (over: Partial<ChatAsset>): ChatAsset => ({
    thumbnailUrl: 'https://thumb.example/1.jpg',
    title: 'A picture',
    ...over,
  });

  it('is one image node carrying the thumbnail, flagged as from outside', () => {
    // The original is whatever format the site that published it chose (an
    // AVIF one is refused by the fetch into storage); the thumbnail is the
    // search service's own JPEG or PNG copy, which the row already shows.
    const nodes = parseClipboardNodes(
      clipboardTextFor(asset({ imageUrl: 'https://original.example/1.avif' })),
    );

    expect(nodes).toEqual([
      {
        type: 'image',
        position: { x: 0, y: 0 },
        name: 'A picture',
        content: 'https://thumb.example/1.jpg',
        external: true,
      },
    ]);
  });

  it('leaves the name out when the picture has no title', () => {
    const nodes = parseClipboardNodes(clipboardTextFor(asset({ title: '' })));

    expect(nodes?.[0]).not.toHaveProperty('name');
  });
});

describe('the copy buttons', () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    toastError.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

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
      title: `Picture ${String(i)}`,
    })),
  });

  it('puts one on every picture square and none on the count', () => {
    render(<MessageBubble message={withImages(8)} />);

    expect(screen.getAllByTestId('asset-copy').length).toBe(
      screen.getAllByTestId('asset-thumb').length,
    );
    expect(within(screen.getByTestId('asset-row-more')).queryByTestId('asset-copy')).toBeNull();
  });

  it('answers a hover on a square with the active border', () => {
    render(<MessageBubble message={withImages(1)} />);

    expect(screen.getByTestId('asset-thumb').className).toContain('hover:border-active-border');
  });

  it('sits beside the square rather than inside it', () => {
    // A button inside a button is not valid markup, and the outer one would
    // swallow the inner one's name and keys.
    render(<MessageBubble message={withImages(1)} />);

    const square = screen.getByTestId('asset-thumb');
    expect(square.contains(screen.getByTestId('asset-copy'))).toBe(false);
  });

  it('copies that picture without opening the box', async () => {
    render(<MessageBubble message={withImages(2)} />);

    await userEvent.click(screen.getAllByTestId('asset-copy')[1] as HTMLElement);

    expect(writeText).toHaveBeenCalledWith(clipboardTextFor({
      thumbnailUrl: 'https://thumb.example/1.jpg',
      imageUrl: 'https://i.example/1.png',
      title: 'Picture 1',
    }));
    expect(screen.queryByTestId('asset-box')).toBeNull();
  });

  it('puts a labelled copy button on the open box, copying the picture on the stage', async () => {
    render(<MessageBubble message={withImages(3)} />);
    await userEvent.click(screen.getAllByTestId('asset-thumb')[2] as HTMLElement);

    const copy = screen.getByTestId('asset-box-copy');
    expect(copy.textContent).toContain('Copy');
    await userEvent.click(copy);

    expect(writeText).toHaveBeenCalledWith(clipboardTextFor({
      thumbnailUrl: 'https://thumb.example/2.jpg',
      imageUrl: 'https://i.example/2.png',
      title: 'Picture 2',
    }));
  });

  it('says copied on both buttons of the picture that was copied', async () => {
    render(<MessageBubble message={withImages(2)} />);

    await userEvent.click(screen.getAllByTestId('asset-copy')[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId('copy-answer').length).toBe(1));

    await userEvent.click(screen.getAllByTestId('asset-thumb')[0] as HTMLElement);
    const box = screen.getByTestId('asset-box');
    expect(within(box).getByTestId('copy-answer')).toBeInTheDocument();
  });

  it('hangs the first square\'s answer to the right, where the row has room', async () => {
    // The first square has nothing to its left inside the column, so an
    // answer hung leftward from its corner is cut off in long-word locales.
    render(<MessageBubble message={withImages(3)} />);

    await userEvent.click(screen.getAllByTestId('asset-copy')[0] as HTMLElement);
    const first = await screen.findByTestId('copy-answer');
    expect(first.className).toContain('left-0');

    await userEvent.click(screen.getAllByTestId('asset-copy')[1] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId('copy-answer').className).toContain('right-0'));
  });

  it('says it could not copy and can be pressed again', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render(<MessageBubble message={withImages(1)} />);

    await userEvent.click(screen.getByTestId('asset-copy'));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('copy-answer')).toBeNull();

    await userEvent.click(screen.getByTestId('asset-copy'));
    await waitFor(() => expect(screen.getByTestId('copy-answer')).toBeInTheDocument());
  });
});
