// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { RailCreateStudioAction } from '@web/pages/studio/rail/RailCreateStudioAction';
import { RAIL_ROW_TOP } from '@web/pages/studio/rail/rail-row';

// Creating a Studio is not the same kind of act as creating something inside
// the Studio you are already in, which is why it sits at the foot of the rail
// rather than beside the other two create actions. This behaviour moved here
// from RailCreateActions; the assertion moved with it rather than being lost
// in the split.
describe('RailCreateStudioAction (rail footer)', () => {
  it('fires onCreateStudio when clicked', () => {
    const onCreateStudio = vi.fn();
    render(
      <RailCreateStudioAction label='New studio' onCreateStudio={onCreateStudio} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New studio' }));
    expect(onCreateStudio).toHaveBeenCalledTimes(1);
  });

  it('is enabled', () => {
    render(<RailCreateStudioAction label='New studio' onCreateStudio={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'New studio' })).toBeEnabled();
  });

  it('is a top-level rail row, from the one definition the other three use', () => {
    render(<RailCreateStudioAction label='New studio' onCreateStudio={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'New studio' }).className).toContain(
      RAIL_ROW_TOP,
    );
  });
});
