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

describe('GroupBackgroundPicker', () => {
  it('renders 无色 + the 4 status swatches', () => {
    setup();
    expect(screen.getByTestId('group-bg-none')).toBeInTheDocument();
    expect(screen.getByTestId('group-bg-info')).toBeInTheDocument();
    expect(screen.getByTestId('group-bg-success')).toBeInTheDocument();
    expect(screen.getByTestId('group-bg-warning')).toBeInTheDocument();
    expect(screen.getByTestId('group-bg-error')).toBeInTheDocument();
  });

  it('applies a tint token when a swatch is chosen', () => {
    const onPick = vi.fn();
    setup({ onPick });
    fireEvent.click(screen.getByTestId('group-bg-info'));
    expect(onPick).toHaveBeenCalledExactlyOnceWith('--color-status-info-bg');
  });

  it('clears the tint when 无色 is chosen', () => {
    const onPick = vi.fn();
    setup({ onPick, value: '--color-status-info-bg' });
    fireEvent.click(screen.getByTestId('group-bg-none'));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
