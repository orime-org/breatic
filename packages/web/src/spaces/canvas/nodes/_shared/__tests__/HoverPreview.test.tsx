// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';

import { HoverPreview } from '@web/spaces/canvas/nodes/_shared/HoverPreview';
import { HOVER_OPEN_DELAY_MS } from '@web/spaces/canvas/nodes/_shared/hover-preview-timing';

// MediaPlayer renders a real <audio>/<video>; jsdom lacks play/pause. Same
// polyfill the MediaPlayer suite uses so the audio/video preview kinds mount.
beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/**
 * Opens the HoverCard by entering its trigger and advancing past the open
 * delay. Radix HoverCard opens on a non-touch `pointerenter` after `openDelay`;
 * fake timers let us cross that grace synchronously. The content is portaled to
 * `document.body`, which `screen` queries by default.
 * @param trigger - The rendered trigger element to hover.
 * @returns Nothing; the card content is mounted after it resolves.
 */
function openCard(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(HOVER_OPEN_DELAY_MS + 10);
  });
}

describe('HoverPreview', () => {
  it('INV-4: HOVER_OPEN_DELAY_MS is 100 (same source as tooltip delayDuration)', () => {
    expect(HOVER_OPEN_DELAY_MS).toBe(100);
  });

  it('INV-2: no src / text / hint → renders the trigger only, never a card', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='image'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    const trigger = screen.getByTestId('trigger');
    openCard(trigger);
    // Empty source: the trigger passes through unwrapped and no card ever opens.
    expect(screen.queryByTestId('hover-preview-content')).not.toBeInTheDocument();
    expect(trigger).toBeInTheDocument();
  });

  it('INV-2: kind=image with src → card shows an <img>, no MediaPlayer', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='image' src='/pic.png' alt='a picture'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    const img = screen.getByAltText('a picture') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('/pic.png');
    expect(screen.queryByTestId('media-element')).not.toBeInTheDocument();
  });

  it('image is sharp (no rounding) and width-locked to 220 like video (#1622 visual)', () => {
    // User decision 2026-07-23: all-sharp corners (A) + width-lock 220 sizing
    // (B), so image renders on the SAME model as video — a 220px-wide wrapper
    // filled by the media (height follows aspect), never rounded.
    vi.useFakeTimers();
    render(
      <HoverPreview kind='image' src='/pic.png' alt='a picture'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    const img = screen.getByAltText('a picture') as HTMLImageElement;
    // A: no rounding on the image (matches video/audio, which are already sharp).
    expect(img.className).not.toContain('rounded');
    // B: width-lock model, not the old 220×220 object-contain bounding box.
    expect(img.className).not.toContain('object-contain');
    expect(img.className).toContain('w-full');
    expect(img.parentElement?.className).toContain('w-[220px]');
  });

  it('INV-2: kind=audio → card renders the MediaPlayer <audio>', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='audio' src='/a.mp3'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    expect(screen.getByTestId('media-element').tagName).toBe('AUDIO');
    expect(screen.getByTestId('waveform')).toBeInTheDocument();
  });

  it('INV-2: kind=video → card renders the MediaPlayer <video>', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='video' src='/v.mp4' poster='/p.jpg'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    expect(screen.getByTestId('media-element').tagName).toBe('VIDEO');
  });

  it('INV-7 via preview variant: audio/video card drops volume + fullscreen', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='video' src='/v.mp4' poster='/p.jpg'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    expect(screen.getByTestId('play-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('seek')).toBeInTheDocument();
    expect(screen.queryByTestId('volume-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen')).not.toBeInTheDocument();
  });

  it('INV-12: opening an audio card does NOT autoplay (click-to-play)', () => {
    vi.useFakeTimers();
    const play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.play = play;
    render(
      <HoverPreview kind='audio' src='/a.mp3'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    expect(screen.getByTestId('media-element')).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it('INV-11: HoverCardContent carries pointer-events:auto so it is clickable inside a modal Sheet', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='video' src='/v.mp4' poster='/p.jpg'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    const content = screen.getByTestId('hover-preview-content');
    expect(content.style.pointerEvents).toBe('auto');
  });

  it('kind=text → card shows the static text body (no media element)', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='text' text='hello reference'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    expect(screen.getByText('hello reference')).toBeInTheDocument();
    expect(screen.queryByTestId('media-element')).not.toBeInTheDocument();
  });

  it('empty source with emptyHint → card shows the hint (unavailable reference)', () => {
    vi.useFakeTimers();
    render(
      <HoverPreview kind='image' emptyHint='Not generated yet'>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    openCard(screen.getByTestId('trigger'));
    expect(screen.getByText('Not generated yet')).toBeInTheDocument();
  });

  it('resolveOnOpen overrides static text and is read live at open (#1815 chip)', () => {
    vi.useFakeTimers();
    let live = 'first';
    render(
      <HoverPreview kind='text' resolveOnOpen={() => ({ text: live })}>
        <span data-testid='trigger'>chip</span>
      </HoverPreview>,
    );
    live = 'updated';
    openCard(screen.getByTestId('trigger'));
    // The body is resolved at hover-open, so it reflects the value at open time.
    expect(screen.getByText('updated')).toBeInTheDocument();
  });
});
