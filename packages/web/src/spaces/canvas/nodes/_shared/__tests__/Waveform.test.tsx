// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Waveform } from '@web/spaces/canvas/nodes/_shared/Waveform';

describe('Waveform', () => {
  it('renders a static set of bars and exposes progress as a slider', () => {
    render(<Waveform progress={0.5} onSeek={vi.fn()} ariaLabel='audio progress' />);
    const slider = screen.getByRole('slider', { name: 'audio progress' });
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    // a fixed decorative shape — many bars, same for every audio node
    expect(screen.getAllByTestId('waveform-bar').length).toBeGreaterThan(8);
  });

  it('colors bars left-of-progress as played and the rest as unplayed', () => {
    render(<Waveform progress={0.5} onSeek={vi.fn()} ariaLabel='p' />);
    const bars = screen.getAllByTestId('waveform-bar');
    const played = bars.filter((b) => b.className.includes('bg-foreground'));
    const unplayed = bars.filter((b) =>
      b.className.includes('bg-muted-foreground'),
    );
    // at progress 0.5 roughly half are played, half unplayed (left-to-right fill)
    expect(played.length).toBeGreaterThan(0);
    expect(unplayed.length).toBeGreaterThan(0);
    expect(played.length + unplayed.length).toBe(bars.length);
  });

  it('click seeks to the clicked fraction', async () => {
    const onSeek = vi.fn();
    const user = userEvent.setup();
    render(<Waveform progress={0} onSeek={onSeek} ariaLabel='p' />);
    const slider = screen.getByRole('slider');
    // jsdom gives 0-size rects; assert onSeek fired with a clamped fraction.
    await user.click(slider);
    expect(onSeek).toHaveBeenCalledTimes(1);
    const f = onSeek.mock.calls[0][0] as number;
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });

  it('ArrowRight / ArrowLeft seek by a step', async () => {
    const onSeek = vi.fn();
    const user = userEvent.setup();
    render(<Waveform progress={0.5} onSeek={onSeek} ariaLabel='p' />);
    const slider = screen.getByRole('slider');
    slider.focus();
    await user.keyboard('{ArrowRight}');
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(0.55, 5));
    await user.keyboard('{ArrowLeft}');
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(0.45, 5));
  });
});
