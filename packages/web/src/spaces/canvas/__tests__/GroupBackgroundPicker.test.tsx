// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GroupBackgroundPicker } from '@web/spaces/canvas/GroupBackgroundPicker';

/**
 * Render the picker open so its portalled swatches are queryable.
 * @param overrides - Props overriding the open / empty-value defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof GroupBackgroundPicker>> = {},
): ReturnType<typeof render> {
  return render(
    <GroupBackgroundPicker
      open
      onOpenChange={() => {}}
      value={undefined}
      onPick={() => {}}
      {...overrides}
    />,
  );
}

describe('GroupBackgroundPicker (#1549 seven-color palette)', () => {
  it('renders 无色 + the 7 palette swatches', () => {
    setup();
    for (const key of [
      'none',
      'red',
      'orange',
      'green',
      'blue',
      'violet',
      'pink',
      'teal',
    ]) {
      expect(screen.getByTestId(`group-bg-${key}`)).toBeInTheDocument();
    }
  });

  it('uses the 6px button radius on the trigger and lays swatches out vertically', () => {
    setup();
    expect(screen.getByTestId('group-bg-trigger')).toHaveClass('rounded-chrome');
    expect(screen.getByTestId('group-bg-list')).toHaveClass('flex-col');
  });

  it('paints swatch dots with the SOLID identity color, not the tint (Chrome model)', () => {
    setup();
    const dot = screen
      .getByTestId('group-bg-red')
      .querySelector('span') as HTMLSpanElement;
    expect(dot.style.backgroundColor).toBe('var(--color-palette-red)');
  });

  it('applies a palette tint token when a swatch is chosen', () => {
    const onPick = vi.fn();
    setup({ onPick });
    fireEvent.click(screen.getByTestId('group-bg-blue'));
    expect(onPick).toHaveBeenCalledExactlyOnceWith('--color-palette-blue-bg');
  });

  it('highlights the matching swatch for a LEGACY stored value (zero-migration normalization)', () => {
    setup({ value: '--color-status-info-bg' });
    // Legacy info tint normalizes to palette blue — the blue swatch must
    // show the selected ring even though the stored string is the old name.
    expect(screen.getByTestId('group-bg-blue').className).toContain('ring-1');
  });

  it('clears the tint when 无色 is chosen', () => {
    const onPick = vi.fn();
    setup({ onPick, value: '--color-palette-blue-bg' });
    fireEvent.click(screen.getByTestId('group-bg-none'));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
