// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ImageModeToggle } from '@web/spaces/canvas/generate/ImageModeToggle';
import type { ImageGenMode } from '@web/spaces/canvas/generate/image-mode-selection';

/**
 * Renders the toggle with the given active mode.
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

describe('ImageModeToggle — the t2i / i2i segmented control', () => {
  it('renders both mode options', () => {
    setup('t2i');
    expect(screen.getByTestId('generate-mode-t2i')).toBeInTheDocument();
    expect(screen.getByTestId('generate-mode-i2i')).toBeInTheDocument();
  });

  it('marks the active mode with aria-pressed and the other unpressed', () => {
    setup('i2i');
    expect(screen.getByTestId('generate-mode-i2i')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('generate-mode-t2i')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('fires onChange with the clicked mode when switching to the other', () => {
    const onChange = vi.fn();
    setup('t2i', onChange);
    fireEvent.click(screen.getByTestId('generate-mode-i2i'));
    expect(onChange).toHaveBeenCalledWith('i2i');
  });

  it('does not fire onChange when clicking the already-active mode', () => {
    // Avoids a redundant setNodeMode write (which would reset the model/params).
    const onChange = vi.fn();
    setup('t2i', onChange);
    fireEvent.click(screen.getByTestId('generate-mode-t2i'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables both options and never fires onChange when disabled', () => {
    // Set while the model catalog is empty (loading / failed) so a toggle can't
    // resolve an empty model and clobber the node's stored model/params.
    const onChange = vi.fn();
    render(<ImageModeToggle value='t2i' onChange={onChange} disabled />);
    expect(screen.getByTestId('generate-mode-t2i')).toBeDisabled();
    expect(screen.getByTestId('generate-mode-i2i')).toBeDisabled();
    fireEvent.click(screen.getByTestId('generate-mode-i2i'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
