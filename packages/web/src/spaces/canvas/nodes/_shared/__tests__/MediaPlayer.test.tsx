// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
});
