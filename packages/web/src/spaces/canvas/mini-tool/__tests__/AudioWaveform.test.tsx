// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the cut band hands wavesurfer.js (inner#1305 §4.4): the peaks file's
 * values and the length when there is a peaks file, and the audio's address
 * only when there is not.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const create = vi.hoisted(() => vi.fn(() => ({ on: () => () => undefined, destroy: () => undefined })));

vi.mock('wavesurfer.js', () => ({ default: { create } }));

const { AudioWaveform } = await import('@web/spaces/canvas/mini-tool/AudioWaveform');

const SRC = 'https://cdn/audio/a.mp3';

afterEach(() => {
  cleanup();
  create.mockClear();
});

describe('AudioWaveform', () => {
  it('draws from the peaks it is given, scaled to 0..1, and loads no audio', () => {
    render(<AudioWaveform src={SRC} peaks={[0, 51, 255]} duration={3600} />);

    const options = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(options).not.toHaveProperty('url');
    expect(options.duration).toBe(3600);
    expect(Array.from((options.peaks as Float32Array[])[0]!)).toEqual([0, 0.2, 1].map((v) => Math.fround(v)));
    expect(screen.getByTestId('mini-tool-waveform')).toHaveAttribute('data-from', 'peaks');
  });

  // The kept span reads in the foreground colour; the band's overlays dim the
  // cut-away ends (design §4.4, the approved demo).
  it('draws its bars in the foreground colour', () => {
    render(<AudioWaveform src={SRC} />);
    expect(screen.getByTestId('mini-tool-waveform')).toHaveClass('text-foreground');
  });

  // As the approved demo draws it: thin bars that stop short of the band's
  // edges, so the handles on them stay visible.
  it('draws one-pixel bars inset from the band\'s top and bottom', () => {
    render(<AudioWaveform src={SRC} />);
    const options = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(options).toMatchObject({ barWidth: 1, barGap: 1 });
    expect(screen.getByTestId('mini-tool-waveform')).toHaveClass('inset-y-1');
  });

  // The bars are painted on a canvas with the colour read when drawn.
  it('draws again when the theme changes', async () => {
    render(<AudioWaveform src={SRC} />);
    expect(create).toHaveBeenCalledTimes(1);
    document.documentElement.dataset.theme = 'dark';
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    delete document.documentElement.dataset.theme;
  });

  it('decodes the audio over a fresh CORS fetch when it has no peaks', () => {
    render(<AudioWaveform src={SRC} />);

    const options = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(options.url).toBe(`${SRC}?cors=1`);
    expect(options).not.toHaveProperty('peaks');
    expect(screen.getByTestId('mini-tool-waveform')).toHaveAttribute('data-from', 'decode');
  });
});
