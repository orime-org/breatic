// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MediaFullscreen } from '@web/spaces/canvas/nodes/_shared/MediaFullscreen';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

/**
 * The layer that sits behind the content: a pointer press here is outside it.
 * @returns The backdrop element.
 */
function backdrop(): HTMLElement {
  const content = screen.getByTestId('media-fullscreen');
  const outside = content.parentElement;
  if (!outside) throw new Error('no backdrop');
  return outside;
}

describe('MediaFullscreen', () => {
  it('shows the image with its close button at the top right of the viewport', () => {
    render(<MediaFullscreen open onOpenChange={() => {}} kind='image' src='/a.png' name='a' />);
    const img = screen.getByTestId('media-fullscreen-image');
    expect(img.getAttribute('src')).toBe('/a.png');
    expect(img.getAttribute('draggable')).toBe('false');
    const close = screen.getByTestId('media-fullscreen-close');
    expect(close.className).toContain('fixed');
    expect(close.className).toContain('right-4');
    expect(close.className).toContain('top-4');
  });

  it('closes on the close button, on Esc and on a press on the backdrop', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<MediaFullscreen open onOpenChange={onOpenChange} kind='image' src='/a.png' name='a' />);

    await user.click(screen.getByTestId('media-fullscreen-close'));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();

    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    onOpenChange.mockClear();

    fireEvent.pointerDown(backdrop());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('covers the image with a skeleton until it loads, and says so when it fails', () => {
    render(<MediaFullscreen open onOpenChange={() => {}} kind='image' src='/a.png' name='a' />);
    expect(screen.getByTestId('media-fullscreen-skeleton')).toBeInTheDocument();
    fireEvent.error(screen.getByTestId('media-fullscreen-image'));
    expect(screen.queryByTestId('media-fullscreen-skeleton')).toBeNull();
    expect(screen.getByTestId('media-fullscreen-error')).toBeInTheDocument();
  });

  it('drops the skeleton once the image loads', () => {
    render(<MediaFullscreen open onOpenChange={() => {}} kind='image' src='/a.png' name='a' />);
    fireEvent.load(screen.getByTestId('media-fullscreen-image'));
    expect(screen.queryByTestId('media-fullscreen-skeleton')).toBeNull();
  });

  // React events cross the portal back to the host: a canvas node would be
  // moved by arrows, unselected by Esc, open its menu, or take a dropped file.
  it('keeps clicks, keys, context menus and drops from reaching the host', async () => {
    const user = userEvent.setup();
    const host = {
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
      onContextMenu: vi.fn(),
      onKeyDown: vi.fn(),
      onDragEnter: vi.fn(),
      onDragOver: vi.fn(),
      onDrop: vi.fn(),
    };
    const onOpenChange = vi.fn();
    render(
      <div {...host}>
        <MediaFullscreen open onOpenChange={onOpenChange} kind='image' src='/a.png' name='a' />
      </div>,
    );
    const img = screen.getByTestId('media-fullscreen-image');
    await user.click(img);
    await user.dblClick(img);
    fireEvent.contextMenu(img);
    fireEvent.keyDown(img, { key: 'ArrowLeft' });
    fireEvent.dragEnter(img);
    fireEvent.dragOver(img);
    fireEvent.drop(img);
    for (const handler of Object.values(host)) expect(handler).not.toHaveBeenCalled();

    // The backdrop press still closes: press events are not stopped.
    fireEvent.pointerDown(backdrop());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('plays the video from the state it was handed', () => {
    render(
      <MediaFullscreen
        open
        onOpenChange={() => {}}
        kind='video'
        src='/v.mp4'
        name='v'
        start={{ time: 6, playing: false, muted: true, volume: 0.3 }}
      />,
    );
    const el = screen.getByTestId('media-element') as HTMLVideoElement;
    expect(el.currentTime).toBe(6);
    expect(el.muted).toBe(true);
    expect(el.volume).toBe(0.3);
    expect(screen.queryByTestId('fullscreen')).toBeNull();
  });

  it('hands the video state back when it closes', async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(
      <MediaFullscreen
        open
        onOpenChange={() => {}}
        onClosed={onClosed}
        kind='video'
        src='/v.mp4'
        name='v'
        start={{ time: 1, playing: false, muted: false, volume: 1 }}
      />,
    );
    const el = screen.getByTestId('media-element') as HTMLVideoElement;
    el.currentTime = 10;
    el.volume = 0.6;
    await user.keyboard('{Escape}');
    expect(onClosed).toHaveBeenCalledWith({ time: 10, playing: false, muted: false, volume: 0.6 });
  });

  it('lets the volume popover close on a press elsewhere inside the layer', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const host = { onClick: vi.fn(), onKeyDown: vi.fn() };
    render(
      <div {...host}>
        <MediaFullscreen open onOpenChange={onOpenChange} kind='video' src='/v.mp4' name='v' />
      </div>,
    );
    await user.click(screen.getByTestId('volume-button'));
    expect(screen.getByTestId('volume')).toBeInTheDocument();
    await user.click(screen.getByTestId('media-element'));
    expect(screen.queryByTestId('volume')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
