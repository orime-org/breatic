// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

describe('SpaceKindPicker', () => {
  it('renders the three space-type cards inside a labelled radiogroup', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Space type' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Canvas/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Document/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Timeline/ })).toBeInTheDocument();
  });

  it('marks the active type checked and the others unchecked', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: /Canvas/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Document/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('disables document + timeline and shows the "not available" badge on them', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: /Document/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Timeline/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Canvas/ })).not.toBeDisabled();
    // The badge appears once per unavailable card (document + timeline).
    expect(screen.getAllByText('Not available')).toHaveLength(2);
  });

  it('reports a click on the available canvas card', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /Canvas/ }));
    expect(onChange).toHaveBeenCalledWith('canvas');
  });

  it('does not report a click on a disabled card', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /Document/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <SpaceKindPicker value='canvas' onChange={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
