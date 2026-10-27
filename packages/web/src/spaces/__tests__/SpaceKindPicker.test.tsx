// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { isInaccessible, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLocale } from '@breatic/shared';

import { SpaceKindPicker } from '@web/spaces/SpaceKindPicker';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import { expectNoA11yViolations } from '@web/test-utils/a11y';
import { LOCALE_CATALOGS } from '@web/test-utils/locale-catalogs';
import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';

describe('SpaceKindPicker', () => {
  it('renders the four space-type cards inside a labelled radiogroup', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    const group = screen.getByRole('radiogroup', { name: 'Space type' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Canvas/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Document/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Timeline/ })).toBeInTheDocument();
  });

  it('lists Canvas, Document, 3D and Timeline in that order', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    const cards = within(screen.getByRole('radiogroup', { name: 'Space type' })).getAllByRole('radio');
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual([
      'space-kind-canvas',
      'space-kind-document',
      'space-kind-3d',
      'space-kind-timeline',
    ]);
  });

  it('shows only each type name as the visible card text', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    const cards = within(screen.getByRole('radiogroup', { name: 'Space type' })).getAllByRole('radio');
    const visibleLabels = cards.map((card) => within(card)
      .queryAllByText(/\S/)
      .filter((element) => !isInaccessible(element))
      .map((element) => element.textContent?.trim())
      .join(' '));
    expect(visibleLabels).toEqual(['Canvas', 'Document', '3D', 'Timeline']);
  });

  it.each(LOCALE_CATALOGS)('labels the 3D type as 3D in %s', (locale) => {
    setLocale(locale);
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    expect(within(screen.getByTestId('space-kind-3d')).getByText('3D', { exact: true })).toBeInTheDocument();
  });

  it.each(LOCALE_CATALOGS)('shows one visible DEV marker while keeping type names in %s', (locale) => {
    setLocale(locale);
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    const markers = within(screen.getByRole('radiogroup')).getAllByText('DEV', { exact: true });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toBeVisible();
    expect(within(screen.getByTestId('space-kind-3d')).getByText('3D', { exact: true })).toBeVisible();
    for (const type of ['canvas', 'document', 'timeline']) {
      expect(within(screen.getByTestId(`space-kind-${type}`)).queryByText('DEV', { exact: true })).not.toBeInTheDocument();
    }
  });

  it.each([
    ['canvas', 'Infinite canvas + nodes'],
    ['document', 'Rich text + collaboration'],
    ['3d', 'Arrange and collaborate in 3D'],
    ['timeline', 'Video / audio editing'],
  ])('explains the %s type in a tooltip on hover', async (type, description) => {
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    const card = screen.getByTestId(`space-kind-${type}`);
    await user.hover(card);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(description);
    expect(tooltip).not.toHaveTextContent('Not available');
  });

  it.each([
    ['canvas', 1, 'Infinite canvas + nodes'],
    ['document', 2, 'Rich text + collaboration'],
    ['3d', 3, 'Arrange and collaborate in 3D'],
    ['timeline', 4, 'Video / audio editing'],
  ] as const)('explains the %s type in a tooltip on keyboard focus', async (type, tabCount, description) => {
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    for (let step = 0; step < tabCount; step += 1) await user.tab();
    expect(screen.getByTestId(`space-kind-${type}`)).toHaveFocus();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(description);
    expect(tooltip).not.toHaveTextContent('Not available');
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

  it('offers Canvas, Document, 3D and Timeline as selectable Space types', () => {
    render(<SpaceKindPicker value='canvas' onChange={() => {}} />);
    for (const name of [/Canvas/, /Document/, /3D/, /Timeline/]) {
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

  it('reports a click on the available 3D card', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SpaceKindPicker value='canvas' onChange={onChange} />);
    await user.click(screen.getByTestId('space-kind-3d'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('3d');
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
    expect(screen.getByTestId('space-kind-3d')).toHaveFocus();
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
