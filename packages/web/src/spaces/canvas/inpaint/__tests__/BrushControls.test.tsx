// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BrushControls } from '@web/spaces/canvas/inpaint/BrushControls';

function setup(overrides: Partial<Parameters<typeof BrushControls>[0]> = {}) {
  const handlers = {
    onToolChange: vi.fn(),
    onBrushSizeChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onUndo: vi.fn(),
  };
  render(
    <BrushControls
      tool='brush'
      brushSize={30}
      opacity={0.8}
      canUndo
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('BrushControls', () => {
  it('marks the active tool with aria-pressed=true', () => {
    setup({ tool: 'erase' });
    expect(
      screen.getByTestId('brush-tool-erase').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('clicking brush fires onToolChange("brush")', async () => {
    const user = userEvent.setup();
    const { onToolChange } = setup({ tool: 'erase' });
    await user.click(screen.getByTestId('brush-tool-brush'));
    expect(onToolChange).toHaveBeenCalledWith('brush');
  });

  // Sliders are the div-based Radix Slider primitive (not native
  // `<input type=range>`), so the value lives on the thumb's aria-valuenow,
  // not an input's `.value` — same cross-browser-consistent control as
  // MediaPlayer's volume / seek sliders.
  it('brush size slider reflects current value', () => {
    setup({ brushSize: 42 });
    expect(
      screen
        .getByRole('slider', { name: 'Brush size' })
        .getAttribute('aria-valuenow'),
    ).toBe('42');
  });

  it('opacity slider maps 0..1 -> 0..100', () => {
    setup({ opacity: 0.3 });
    expect(
      screen
        .getByRole('slider', { name: 'Opacity' })
        .getAttribute('aria-valuenow'),
    ).toBe('30');
  });

  it('ArrowRight on the size slider fires onBrushSizeChange (div-slider stays interactive)', async () => {
    const user = userEvent.setup();
    const { onBrushSizeChange } = setup({ brushSize: 30 });
    screen.getByRole('slider', { name: 'Brush size' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onBrushSizeChange).toHaveBeenCalledWith(31);
  });

  it('ArrowRight on the opacity slider fires onOpacityChange in 0..1', async () => {
    const user = userEvent.setup();
    const { onOpacityChange } = setup({ opacity: 0.3 });
    screen.getByRole('slider', { name: 'Opacity' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onOpacityChange).toHaveBeenCalledWith(0.31);
  });

  it('Undo button is disabled when canUndo=false', () => {
    setup({ canUndo: false });
    expect(
      (screen.getByTestId('brush-undo') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
