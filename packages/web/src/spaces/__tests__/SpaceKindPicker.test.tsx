// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';

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
    expect(screen.getByRole('radio', { name: /Timeline/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('fills the picked card past the fill the others take under the pointer', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    expectChosenFill(screen.getByRole('radio', { name: /Canvas/ }));
    expectHoverableSiblingFill(screen.getByRole('radio', { name: /Document/ }));
    expectHoverableSiblingFill(screen.getByRole('radio', { name: /Timeline/ }));
  });

  it('offers Canvas, Document and Timeline as selectable Space types', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    for (const name of [/Canvas/, /Document/, /Timeline/]) {
      const card = screen.getByRole('radio', { name });
      expect(card).not.toBeDisabled();
      expect(card).not.toHaveAttribute('aria-disabled', 'true');
    }
    expect(screen.queryByText('Not available')).toBe(null);
  });

  it('reports a click on the document card', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /Document/ }));
    expect(onChange).toHaveBeenCalledWith('document');
  });

  it('reports a click on the available canvas card', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /Canvas/ }));
    expect(onChange).toHaveBeenCalledWith('canvas');
  });

  it('reports a click on Timeline and reflects the controlled selection', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: /Timeline/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('timeline');
    rerender(<SpaceKindPicker value='timeline' onChange={onChange} />);
    expect(screen.getByRole('radio', { name: /Timeline/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Canvas/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: /Document/ })).toHaveAttribute('aria-checked', 'false');
  });

  it.each(['{Enter}', ' '])('selects Timeline with %s after keyboard navigation', async (key) => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: /Canvas/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('radio', { name: /Document/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('radio', { name: /Timeline/ })).toHaveFocus();
    await user.keyboard(key);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('timeline');
  });

  it('keeps the selected Timeline fill distinct from its hoverable siblings', () => {
    render(<SpaceKindPicker value='timeline' onChange={() => {}} />);
    expectChosenFill(screen.getByRole('radio', { name: /Timeline/ }));
    expectHoverableSiblingFill(screen.getByRole('radio', { name: /Canvas/ }));
    expectHoverableSiblingFill(screen.getByRole('radio', { name: /Document/ }));
  });

  it('has no a11y violations', async () => {
    const { container } = render(
      <SpaceKindPicker value='canvas' onChange={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
