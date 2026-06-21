// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MediaPlayer } from '@web/spaces/canvas/nodes/_shared/MediaPlayer';

beforeAll(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
});

describe('MediaPlayer', () => {
  it('audio: renders a waveform, play + volume, and NO seek / fullscreen', () => {
    render(<MediaPlayer modality='audio' src='/a.mp3' />);
    expect(screen.getByTestId('media-element').tagName).toBe('AUDIO');
    expect(screen.getByTestId('waveform')).toBeInTheDocument();
    expect(screen.getByTestId('play-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('volume')).toBeInTheDocument();
    expect(screen.queryByTestId('seek')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fullscreen')).not.toBeInTheDocument();
  });

  it('video: renders the video, a seek scrubber + a fullscreen button, NO waveform', () => {
    render(<MediaPlayer modality='video' src='/v.mp4' poster='/p.jpg' />);
    expect(screen.getByTestId('media-element').tagName).toBe('VIDEO');
    expect(screen.getByTestId('seek')).toBeInTheDocument();
    expect(screen.getByTestId('fullscreen')).toBeInTheDocument();
    expect(screen.queryByTestId('waveform')).not.toBeInTheDocument();
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
});
