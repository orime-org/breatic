// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ImageModeToggle } from '@web/spaces/canvas/generate/ImageModeToggle';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';

/**
 * Renders the mode picker with the given active mode.
 * @param value - The active generation mode.
 * @param onChange - The change handler (defaults to a no-op).
 * @returns The render result.
 */
function setup(
  value: ImageGenMode,
  onChange: (mode: ImageGenMode) => void = () => {},
): ReturnType<typeof render> {
  return render(<ImageModeToggle value={value} onChange={onChange} />);
}

describe('ImageModeToggle — the t2i / i2i mode popover', () => {
  it('shows the active mode label (English, not localized) on the trigger', () => {
    setup('i2i');
    expect(screen.getByTestId('generate-mode-trigger')).toHaveTextContent(
      'Image to Image',
    );
  });

  it('opens the popover to reveal both mode options', () => {
    setup('t2i');
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    expect(screen.getByTestId('generate-mode-t2i')).toBeInTheDocument();
    expect(screen.getByTestId('generate-mode-i2i')).toBeInTheDocument();
  });

  it('marks the active mode option as selected', () => {
    setup('i2i');
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    expect(screen.getByTestId('generate-mode-i2i')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('generate-mode-t2i')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('fires onChange with the picked mode when switching to the other', () => {
    const onChange = vi.fn();
    setup('t2i', onChange);
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(screen.getByTestId('generate-mode-i2i'));
    expect(onChange).toHaveBeenCalledWith('i2i');
  });

  it('does not fire onChange when picking the already-active mode', () => {
    // Avoids a redundant setNodeMode write (which would reset the model/params).
    const onChange = vi.fn();
    setup('t2i', onChange);
    fireEvent.click(screen.getByTestId('generate-mode-trigger'));
    fireEvent.click(screen.getByTestId('generate-mode-t2i'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables the trigger (cannot open) when the catalog is empty', () => {
    // Set while the model catalog is empty (loading / failed) so a switch can't
    // resolve an empty model and clobber the node's stored model/params.
    const onChange = vi.fn();
    render(<ImageModeToggle value='t2i' onChange={onChange} disabled />);
    const trigger = screen.getByTestId('generate-mode-trigger');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('generate-mode-i2i')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
