// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Waveform } from '@web/spaces/canvas/nodes/_shared/Waveform';

describe('Waveform', () => {
  it('renders a static decorative set of bars', () => {
    render(<Waveform progress={0.5} />);
    // a fixed decorative shape — many bars, same for every audio node
    expect(screen.getAllByTestId('waveform-bar').length).toBeGreaterThan(8);
  });

  it('fills played bars left-to-right with a mid-grey, never the harsh foreground extreme', () => {
    render(<Waveform progress={0.5} />);
    const bars = screen.getAllByTestId('waveform-bar');
    const played = bars.filter((b) => b.className.includes('bg-muted-foreground'));
    // played uses muted-foreground (mid grey, moderate in both colour modes),
    // NOT bg-foreground (the near-black / near-white extreme).
    expect(bars.some((b) => b.className.includes('bg-foreground'))).toBe(false);
    // at progress 0.5 roughly half are filled (full mid-grey), half are the
    // dimmer unplayed tint — left-to-right.
    const fullyPlayed = bars.filter(
      (b) =>
        b.className.includes('bg-muted-foreground') &&
        !b.className.includes('bg-muted-foreground/30'),
    );
    expect(fullyPlayed.length).toBeGreaterThan(0);
    expect(played.length).toBe(bars.length); // every bar is some muted-foreground tint
  });

  it('is purely decorative — no seek role / no `nodrag`, so dragging it moves the node', () => {
    render(<Waveform progress={0} />);
    const wave = screen.getByTestId('waveform');
    expect(wave.getAttribute('role')).not.toBe('slider');
    // no `nodrag` → ReactFlow treats a drag here as a node move (seek lives in
    // the control row's slider instead).
    expect(wave.className).not.toContain('nodrag');
  });
});
