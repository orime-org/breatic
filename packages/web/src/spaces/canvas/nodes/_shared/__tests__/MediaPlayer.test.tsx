// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

describe('MediaPlayer', () => {
  it('audio: decorative waveform + play + seek slider + volume; NO fullscreen', () => {
    render(<MediaPlayer modality='audio' src='/a.mp3' />);
    expect(screen.getByTestId('media-element').tagName).toBe('AUDIO');
    expect(screen.getByTestId('waveform')).toBeInTheDocument();
    expect(screen.getByTestId('play-toggle')).toBeInTheDocument();
    // seek now lives in the control row (the waveform is decorative, drag = move node)
    expect(screen.getByTestId('seek')).toBeInTheDocument();
    expect(screen.getByTestId('volume-button')).toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen')).not.toBeInTheDocument();
  });

  it('video: seek slider + fullscreen + volume button, NO waveform', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' />);
    expect(screen.getByTestId('media-element').tagName).toBe('VIDEO');
    expect(screen.getByTestId('seek')).toBeInTheDocument();
    expect(screen.getByTestId('fullscreen')).toBeInTheDocument();
    expect(screen.getByTestId('volume-button')).toBeInTheDocument();
    expect(screen.queryByTestId('waveform')).not.toBeInTheDocument();
  });

  // #1622: the preview variant (hover preview) drops volume + fullscreen so
  // it can live inside an auto-close HoverCard. INV-7.
  it('audio variant="preview": waveform + play + seek, NO volume, NO fullscreen', () => {
    render(<MediaPlayer modality='audio' src='/a.mp3' variant='preview' />);
    expect(screen.getByTestId('waveform')).toBeInTheDocument();
    expect(screen.getByTestId('play-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('seek')).toBeInTheDocument();
    expect(screen.queryByTestId('volume-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen')).not.toBeInTheDocument();
  });

  it('video variant="preview": play + seek, NO volume, NO fullscreen', () => {
    render(
      <MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' variant='preview' />,
    );
    expect(screen.getByTestId('media-element').tagName).toBe('VIDEO');
    expect(screen.getByTestId('play-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('seek')).toBeInTheDocument();
    expect(screen.queryByTestId('volume-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen')).not.toBeInTheDocument();
    expect(screen.getByTestId('time-current').className).not.toContain('hidden');
    expect(screen.getByTestId('time-total').className).not.toContain('hidden');
  });

  it('video variant="full": hides the times only below its 16rem container width', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' />);
    for (const id of ['time-current', 'time-total']) {
      expect(screen.getByTestId(id).className).toContain('hidden');
      expect(screen.getByTestId(id).className).toContain('@min-[16rem]:inline');
    }
  });

  // #1772: pin the metadata-only preload as a contract. The HTML spec leaves
  // the missing-value default to the UA; explicit `metadata` guarantees the
  // duration display + video dimension badge work without downloading the
  // full media file for every node on canvas load.
  it('audio and video preload metadata only, never the full file (#1772)', () => {
    const { unmount } = render(<MediaPlayer modality='audio' src='/a.mp3' />);
    expect(screen.getByTestId('media-element').getAttribute('preload')).toBe(
      'metadata',
    );
    unmount();
    render(<MediaPlayer modality='video' src='/v.mp4' />);
    expect(screen.getByTestId('media-element').getAttribute('preload')).toBe(
      'metadata',
    );
  });

  it('clicking play calls the element play()', async () => {
    const user = userEvent.setup();
    render(<MediaPlayer modality='audio' src='/a.mp3' />);
    const el = screen.getByTestId('media-element') as HTMLAudioElement;
    await user.click(screen.getByTestId('play-toggle'));
    expect(el.play).toHaveBeenCalledTimes(1);
  });

  it('clicking fullscreen requests fullscreen (standard API) on the video', async () => {
    const user = userEvent.setup();
    const fs = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.requestFullscreen = fs;
    render(<MediaPlayer modality='video' src='/v.mp4' />);
    await user.click(screen.getByTestId('fullscreen'));
    expect(fs).toHaveBeenCalledTimes(1);
  });

  // --- final layout (acceptance items 12-17) ---

  it('item 12: video controls overlay the video bottom (absolute); audio controls sit below (not absolute)', () => {
    const { unmount } = render(<MediaPlayer modality='video' src='/v.mp4' />);
    expect(screen.getByTestId('controls').className).toContain('absolute');
    unmount();
    render(<MediaPlayer modality='audio' src='/a.mp3' />);
    expect(screen.getByTestId('controls').className).not.toContain('absolute');
  });

  it('item 16: control bar carries `nodrag` so ReactFlow does not hijack slider drags', () => {
    const { unmount } = render(<MediaPlayer modality='video' src='/v.mp4' />);
    expect(screen.getByTestId('controls').className).toContain('nodrag');
    unmount();
    render(<MediaPlayer modality='audio' src='/a.mp3' />);
    expect(screen.getByTestId('controls').className).toContain('nodrag');
  });

  it('item 13: volume button opens a popover with the volume slider (not inline)', async () => {
    const user = userEvent.setup();
    render(<MediaPlayer modality='video' src='/v.mp4' />);
    // closed by default → no inline volume slider eating bar width
    expect(screen.queryByTestId('volume')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('volume-button'));
    expect(screen.getByTestId('volume')).toBeInTheDocument();
  });

  it('item: seek is a div-based Radix slider (role=slider), not a native range input', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' />);
    const seek = screen.getByTestId('seek');
    expect(seek.querySelector('input[type="range"]')).toBeNull();
    expect(seek.querySelector('[role="slider"]')).not.toBeNull();
  });

  it('volume percentage has a fixed-width centered box so the popover does not reflow between 2- and 3-digit values', async () => {
    const user = userEvent.setup();
    render(<MediaPlayer modality='video' src='/v.mp4' />);
    await user.click(screen.getByTestId('volume-button'));
    const pct = screen.getByTestId('volume-pct');
    // fixed-width box that fits the widest value ("100") so 2- vs 3-digit
    // values don't reflow the popover (kept tight — not over-wide).
    expect(pct.className).toContain('w-6');
    expect(pct.className).toContain('text-center');
  });

  // #1616: video surfaces its intrinsic pixel size via onDimensions so the
  // node can render a resolution badge; audio has no pixel size and must not.
  it('video: onLoadedMetadata reports the pixel dimensions via onDimensions (#1616)', () => {
    const onDimensions = vi.fn();
    render(
      <MediaPlayer modality='video' src='/v.mp4' onDimensions={onDimensions} />,
    );
    const v = screen.getByTestId('media-element');
    Object.defineProperty(v, 'videoWidth', { value: 640, configurable: true });
    Object.defineProperty(v, 'videoHeight', { value: 480, configurable: true });
    fireEvent.loadedMetadata(v);
    expect(onDimensions).toHaveBeenCalledWith({ width: 640, height: 480 });
  });

  it('audio: never reports dimensions (no pixel size) (#1616)', () => {
    const onDimensions = vi.fn();
    render(
      <MediaPlayer modality='audio' src='/a.mp3' onDimensions={onDimensions} />,
    );
    fireEvent.loadedMetadata(screen.getByTestId('media-element'));
    expect(onDimensions).not.toHaveBeenCalled();
  });

  // #1987 A5: during a focus pick the node's own control bar slides away and
  // stops being reachable — clicking play on a node the user is trying to PICK
  // fires both the toggle and the pick (§2.6).
  it('video: controlsHidden slides the bar out AND makes it unreachable (#1987 A5)', () => {
    const { rerender } = render(
      <MediaPlayer modality='video' src='/v.mp4' controlsHidden />,
    );
    const bar = screen.getByTestId('controls');
    // `inert` rather than unmounting: the element must stay for the slide-out
    // to have something to animate, and inert takes it out of the tab order,
    // the a11y tree and hit-testing all at once.
    expect(bar.hasAttribute('inert')).toBe(true);
    expect(bar.className).toContain('translate-y-full');
    rerender(<MediaPlayer modality='video' src='/v.mp4' />);
    const shown = screen.getByTestId('controls');
    expect(shown.hasAttribute('inert')).toBe(false);
    expect(shown.className).not.toContain('translate-y-full');
  });
});

// A video's poster is its cover, and the cover has a preview (at most 576 wide) beside
// it (inner#1320).
describe('MediaPlayer poster', () => {
  const COVER =
    'https://resource-dev.breatic.cc/video/2026-09-30/1_18f58aed-b802-4243-a8ea-02d377de9679_cover.png';

  it('shows the cover preview as the poster', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster={COVER} />);

    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(
      `${COVER}.preview.webp`,
    );
  });
});

// inner#1472: zoomed past the cover preview, the stretched preview is not shown
// while the original cover loads.
describe('MediaPlayer zoomed past its cover preview', () => {
  const COVER =
    'https://resource-dev.breatic.cc/video/2026-09-30/2_18f58aed-b802-4243-a8ea-02d377de9679_cover.png';
  const SIZE = { width: 1920, height: 1080 } as const;
  let probes: { src: string; onload: (() => void) | null; onerror: (() => void) | null }[] = [];

  beforeEach(() => {
    probes = [];
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 0;
        constructor() {
          probes.push(this);
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Settles the off-screen load of one address.
   * @param src - The address.
   * @param ok - Whether it loaded.
   */
  function settle(src: string, ok: boolean): void {
    act(() => {
      for (const probe of probes.filter((p) => p.src === src)) (ok ? probe.onload : probe.onerror)?.();
    });
  }

  /**
   * The player, zoomed past its cover or not.
   * @param fullPoster - Whether the canvas is past the preview.
   * @returns The element.
   */
  function player(fullPoster: boolean): React.JSX.Element {
    return <MediaPlayer modality='video' src='/v.mp4' poster={COVER} size={SIZE} fullPoster={fullPoster} />;
  }

  it('hides the video under the skeleton until the original cover loads', () => {
    const { rerender } = render(player(false));
    fireEvent.loadedData(screen.getByTestId('media-element'));
    expect(screen.queryByTestId('media-skeleton')).toBeNull();

    rerender(player(true));
    expect(screen.getByTestId('media-skeleton')).toBeInTheDocument();
    expect(screen.getByTestId('media-element')).toHaveClass('opacity-0');

    settle(COVER, true);
    expect(screen.queryByTestId('media-skeleton')).toBeNull();
    expect(screen.getByTestId('media-element')).not.toHaveClass('opacity-0');
    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(COVER);
  });

  it('goes back to the cover preview when the original cover fails', () => {
    const { rerender } = render(player(false));
    fireEvent.loadedData(screen.getByTestId('media-element'));
    rerender(player(true));

    settle(COVER, false);

    expect(screen.queryByTestId('media-skeleton')).toBeNull();
    expect(screen.getByTestId('media-element')).not.toHaveClass('opacity-0');
    expect(screen.getByTestId('media-element').getAttribute('poster')).toBe(`${COVER}.preview.webp`);
  });

  it('leaves a video that has started playing alone, its cover being gone', () => {
    const { rerender } = render(player(false));
    const video = screen.getByTestId('media-element');
    fireEvent.loadedData(video);
    fireEvent.play(video);

    rerender(player(true));

    expect(screen.queryByTestId('media-skeleton')).toBeNull();
    expect(screen.getByTestId('media-element')).not.toHaveClass('opacity-0');
  });
});

// inner#1320: a video node with a known size reserves its box before the
// poster arrives and covers it with the skeleton, as an image node does.
describe('MediaPlayer video with a known size', () => {
  it('reserves the box from the size and shows the skeleton', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' size={{ width: 1080, height: 3840 }} />);
    const video = screen.getByTestId('media-element');

    expect(video.getAttribute('width')).toBe('1080');
    expect(video.getAttribute('height')).toBe('3840');
    expect(video).toHaveClass('h-auto');
    expect(screen.getByTestId('media-skeleton')).toBeInTheDocument();
    // inner#1472: a half-loaded poster does not show through the skeleton.
    expect(video).toHaveClass('opacity-0');
  });

  it('drops the skeleton once the video has its first frame', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' size={{ width: 1080, height: 3840 }} />);

    fireEvent.loadedData(screen.getByTestId('media-element'));

    expect(screen.queryByTestId('media-skeleton')).toBeNull();
    expect(screen.getByTestId('media-element')).not.toHaveClass('opacity-0');
  });

  it('reserves nothing and shows no skeleton without a size', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' variant='preview' />);

    expect(screen.getByTestId('media-element').getAttribute('width')).toBeNull();
    expect(screen.queryByTestId('media-skeleton')).toBeNull();
  });
});
