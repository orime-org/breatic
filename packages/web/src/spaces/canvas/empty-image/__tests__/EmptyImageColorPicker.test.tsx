// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type * as React from 'react';

// Mock react-colorful to its wiring surface — the library's own pointer /
// canvas internals aren't jsdom-testable and aren't our code; we only assert
// that OUR component threads value / onChange through it.
vi.mock('react-colorful', () => ({
  HexColorPicker: ({
    color,
    onChange,
  }: {
    color: string;
    onChange: (hex: string) => void;
  }) => (
    <button
      type='button'
      data-testid='mock-hex-picker'
      data-color={color}
      onClick={() => onChange('#123456')}
    >
      picker
    </button>
  ),
  HexColorInput: ({
    color,
    onChange,
  }: {
    color: string;
    onChange: (hex: string) => void;
  }) => (
    <input
      data-testid='mock-hex-input'
      value={color}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value)
      }
    />
  ),
}));

import { EmptyImageColorPicker } from '@web/spaces/canvas/empty-image/EmptyImageColorPicker';

describe('EmptyImageColorPicker', () => {
  it('the trigger swatch shows the current colour', () => {
    render(<EmptyImageColorPicker value='#ffffff' onChange={() => {}} />);
    const swatch = screen.getByTestId('empty-image-color-custom');
    expect(swatch.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('stays closed until the swatch is clicked', () => {
    render(<EmptyImageColorPicker value='#ffffff' onChange={() => {}} />);
    expect(screen.queryByTestId('mock-hex-picker')).not.toBeInTheDocument();
  });

  it('opens the picker popover on click', () => {
    render(<EmptyImageColorPicker value='#ffffff' onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('empty-image-color-custom'));
    expect(screen.getByTestId('mock-hex-picker')).toBeInTheDocument();
    expect(screen.getByTestId('mock-hex-input')).toBeInTheDocument();
  });

  it('forwards a picked colour through onChange', () => {
    const onChange = vi.fn();
    render(<EmptyImageColorPicker value='#ffffff' onChange={onChange} />);
    fireEvent.click(screen.getByTestId('empty-image-color-custom'));
    fireEvent.click(screen.getByTestId('mock-hex-picker'));
    expect(onChange).toHaveBeenCalledWith('#123456');
  });

  it('forwards a typed hex through onChange', () => {
    const onChange = vi.fn();
    render(<EmptyImageColorPicker value='#ffffff' onChange={onChange} />);
    fireEvent.click(screen.getByTestId('empty-image-color-custom'));
    fireEvent.change(screen.getByTestId('mock-hex-input'), {
      target: { value: '#abcdef' },
    });
    expect(onChange).toHaveBeenCalledWith('#abcdef');
  });
});
