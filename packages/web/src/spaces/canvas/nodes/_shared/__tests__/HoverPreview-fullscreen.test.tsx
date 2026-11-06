// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { HoverPreview, type HoverPreviewProps } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Hovers the trigger past the open delay.
 * @param trigger - The trigger element.
 */
function openCard(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
  });
}

/**
 * Renders a preview around a trigger and opens its card.
 * @param props - Preview props without children.
 */
function hover(props: Omit<HoverPreviewProps, 'children'>): void {
  vi.useFakeTimers();
  render(
    <HoverPreview {...props}>
      <span data-testid='trigger'>chip</span>
    </HoverPreview>,
  );
  openCard(screen.getByTestId('trigger'));
}

// inner#1844: every image and video hover preview opens full screen from its
// top-right corner.
describe('HoverPreview full-screen button', () => {
  it.each([
    ['image', { kind: 'image', src: '/a.png' }],
    ['video', { kind: 'video', src: '/v.mp4', poster: '/p.png' }],
  ] as const)('%s preview has the button over its top-right corner', (_, props) => {
    hover(props);
    const button = screen.getByTestId('media-fullscreen-button');
    expect(screen.getByTestId('hover-preview-content')).toContainElement(button);
    expect(button.className).toContain('group-hover/media:opacity-100');
  });

  it.each([
    ['text', { kind: 'text', text: 'hello' }],
    ['audio', { kind: 'audio', src: '/a.mp3' }],
    ['custom body', { kind: 'image', src: '/a.png', body: <div>card</div> }],
  ] as const)('%s preview has no button', (_, props) => {
    hover(props);
    expect(screen.getByTestId('hover-preview-content')).toBeInTheDocument();
    expect(screen.queryByTestId('media-fullscreen-button')).toBeNull();
  });

  it('closes the card and keeps the full-screen layer open', () => {
    hover({ kind: 'image', src: '/a.png' });
    fireEvent.click(screen.getByTestId('media-fullscreen-button'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
    expect(screen.getByTestId('media-fullscreen')).toBeInTheDocument();
  });

  it('does not reopen the card when the full-screen layer closes', () => {
    hover({ kind: 'image', src: '/a.png' });
    fireEvent.click(screen.getByTestId('media-fullscreen-button'));
    fireEvent.click(screen.getByTestId('media-fullscreen-close'));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('media-fullscreen')).toBeNull();
    expect(screen.queryByTestId('hover-preview-content')).toBeNull();
  });

  it('shows what `fullscreen` names in place of the preview', () => {
    hover({
      kind: 'image',
      src: '/thumb.png',
      fullscreen: { kind: 'video', src: '/full.mp4', poster: '/cover.png' },
    });
    fireEvent.click(screen.getByTestId('media-fullscreen-button'));
    const video = screen.getByTestId('media-fullscreen').querySelector('video');
    expect(video?.getAttribute('src')).toBe('/full.mp4');
  });

  it('reads a `fullscreen` function when the card opens', () => {
    let source = '/first.png';
    hover({ kind: 'image', src: '/thumb.png', fullscreen: () => ({ kind: 'image', src: source }) });
    source = '/second.png';
    fireEvent.click(screen.getByTestId('media-fullscreen-button'));
    expect(screen.getByTestId('media-fullscreen-image').getAttribute('src')).toBe('/first.png');
  });

  it('has no button when `fullscreen` resolves to nothing', () => {
    hover({ kind: 'image', src: '/thumb.png', fullscreen: () => null });
    expect(screen.queryByTestId('media-fullscreen-button')).toBeNull();
  });

  it('continues a preview video from where it was', () => {
    hover({ kind: 'video', src: '/v.mp4' });
    const preview = screen.getByTestId('media-element') as HTMLVideoElement;
    preview.currentTime = 8;
    fireEvent.click(screen.getByTestId('media-fullscreen-button'));
    const full = screen.getByTestId('media-fullscreen').querySelector('video');
    expect(full?.currentTime).toBe(8);
  });
});
