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
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' />);
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
    const onClose = vi.fn();
    render(<MediaFullscreen onClose={onClose} kind='image' src='/a.png' name='a' />);

    await user.click(screen.getByTestId('media-fullscreen-close'));
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();

    fireEvent.pointerDown(backdrop());
    expect(onClose).toHaveBeenCalled();
  });

  it('covers the image with a skeleton until it loads, and says so when it fails', () => {
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' />);
    expect(screen.getByTestId('media-fullscreen-skeleton')).toBeInTheDocument();
    fireEvent.error(screen.getByTestId('media-fullscreen-image'));
    expect(screen.queryByTestId('media-fullscreen-skeleton')).toBeNull();
    expect(screen.getByTestId('media-fullscreen-error')).toBeInTheDocument();
  });

  it('drops the skeleton once the image loads', () => {
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' />);
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
    const onClose = vi.fn();
    render(
      <div {...host}>
        <MediaFullscreen onClose={onClose} kind='image' src='/a.png' name='a' />
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
    expect(onClose).toHaveBeenCalled();
  });

  it('plays the video from the state it was handed', () => {
    render(
      <MediaFullscreen
        onClose={() => {}}
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
  });

  // A video of unknown size is held to the viewport's height by its width
  // once its own size is read, so the bar is as wide as the picture.
  it('sizes a video of unknown size from its metadata', () => {
    render(<MediaFullscreen onClose={() => {}} kind='video' src='/v.mp4' name='v' />);
    const el = screen.getByTestId('media-element');
    Object.defineProperty(el, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(el, 'videoHeight', { value: 480, configurable: true });
    fireEvent.loadedMetadata(el);
    const content = screen.getByTestId('media-fullscreen');
    expect(content.style.getPropertyValue('--media-aspect')).toBe(String(640 / 480));
    expect(content.className).toContain('w-[min(96vw,1600px,calc(90vh*var(--media-aspect,100)),var(--media-width,100vw))]');
  });

  it('sizes a video from the size its host knows', () => {
    render(<MediaFullscreen onClose={() => {}} kind='video' src='/v.mp4' name='v' size={{ width: 1080, height: 1920 }} />);
    expect(screen.getByTestId('media-fullscreen').style.getPropertyValue('--media-aspect')).toBe(String(1080 / 1920));
  });

  // inner#1844 round 1: beside a narrow picture is backdrop, so a press there closes.
  it('sizes the image content to the picture', () => {
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' />);
    expect(screen.getByTestId('media-fullscreen').className).toContain('w-fit');
  });

  // The window's stray-file guard never sees a drag this layer stops, so the
  // layer cancels the browser's open-the-file default itself.
  it('cancels a file dropped on the layer', () => {
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' />);
    const img = screen.getByTestId('media-fullscreen-image');
    const transfer = { types: ['Files'], dropEffect: 'copy' };
    const over = fireEvent.dragOver(img, { dataTransfer: transfer });
    const drop = fireEvent.drop(img, { dataTransfer: transfer });
    expect(over).toBe(false);
    expect(drop).toBe(false);
  });

  it('shows the original cover, not its stretched preview', () => {
    const cover = 'https://resource-dev.breatic.cc/video/2026-09-30/1_18f58aed-b802-4243-a8ea-02d377de9679_cover.png';
    render(<MediaFullscreen onClose={() => {}} kind='video' src='/v.mp4' poster={cover} name='v' />);
    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(cover);
  });

  // inner#1844 round 3: images and videos share one sizing rule. With the size
  // known the box is reserved before the file arrives, so nothing jumps.
  it('reserves an image box from its size before it loads', () => {
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' size={{ width: 1200, height: 800 }} />);
    const content = screen.getByTestId('media-fullscreen');
    expect(content.style.getPropertyValue('--media-aspect')).toBe(String(1200 / 800));
    expect(content.style.getPropertyValue('--media-width')).toBe('1200px');
    expect(content.className).toContain('w-[min(96vw,1600px,calc(90vh*var(--media-aspect,100)),var(--media-width,100vw))]');
    expect(screen.getByTestId('media-fullscreen-image').className).toContain('h-full w-full');
    expect(screen.getByTestId('media-fullscreen-skeleton').parentElement?.className).toContain('aspect-[var(--media-aspect)]');
  });

  it('holds a centred square while an image of unknown size loads', () => {
    render(<MediaFullscreen onClose={() => {}} kind='image' src='/a.png' name='a' />);
    expect(screen.getByTestId('media-fullscreen-skeleton').parentElement?.className).toContain('min-h-40 min-w-40');
  });

  it('hands the video state back when it closes', async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    render(
      <MediaFullscreen
        onClose={onClosed}
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
    const onClose = vi.fn();
    const host = { onClick: vi.fn(), onKeyDown: vi.fn() };
    render(
      <div {...host}>
        <MediaFullscreen onClose={onClose} kind='video' src='/v.mp4' name='v' />
      </div>,
    );
    await user.click(screen.getByTestId('volume-button'));
    expect(screen.getByTestId('volume')).toBeInTheDocument();
    await user.click(screen.getByTestId('media-element'));
    expect(screen.queryByTestId('volume')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
