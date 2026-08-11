// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import {
  RAIL_ROW_NESTED,
  RAIL_ROW_TOP,
} from '@web/pages/studio/rail/rail-row';
import { StudioRailDrawer } from '@web/pages/studio/rail/StudioRailDrawer';

function setup() {
  return render(
    <MemoryRouter>
      <StudioRailDrawer
        studios={[]}
        activeSlug={null}
        onCreateProject={() => {}}
        onCreateStudio={() => {}}
      />
    </MemoryRouter>,
  );
}

describe('StudioRailDrawer (narrow-screen rail)', () => {
  it('renders a hamburger button that hides at md and up', () => {
    setup();
    const button = screen.getByRole('button', { name: 'Open navigation' });
    // The persistent rail takes over at md, so the hamburger is md:hidden.
    expect(button.className).toContain('md:hidden');
  });

  it('opens a left drawer carrying the shared rail content on click', async () => {
    const user = userEvent.setup();
    setup();
    // Closed initially — the drawer content is not mounted.
    expect(screen.queryByTestId('studio-rail-drawer')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByTestId('studio-rail-drawer')).toBeInTheDocument();
    // The same StudioRailContent (the Recent nav link) renders inside.
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('shows a Breatic brand header so the close button gets its own row', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    // The drawer header carries the brand; this gives the vendor Sheet close
    // (X, absolute top-right) its own top row instead of overlapping the first
    // rail item ("Recent").
    expect(screen.getByText('Breatic')).toBeInTheDocument();
  });

  // The two hosts share StudioRailContent so they cannot drift, but the parts
  // each host owns — the single rule, the pinned footer, the icon colour — are
  // written twice. Asserting them only on the desktop rail would let the
  // drawer's copy change with every desktop test still green, which is the
  // drift that sharing the content was meant to rule out.

  it('offsets its header from outside the box, not from inside it', async () => {
    // The header is a fixed h-9 and the Sheet's own close button is absolutely
    // positioned against the drawer, not against this row. Padding the header
    // from inside shrinks its content box from 36 to 28, which moves the
    // vertically centred brand up by four while the close button stays put —
    // they stop lining up. A margin moves the whole box instead.
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const header = screen.getByText('Breatic').closest('div');
    expect(header?.className).toContain('mt-2');
    expect(header?.className).not.toContain('pt-2');
  });

  it('draws the same single rule the desktop rail does', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(
      screen.getByTestId('studio-rail-drawer').querySelectorAll('hr'),
    ).toHaveLength(1);
  });

  it('pins create-studio outside the scrolling area, as the desktop rail does', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByTestId('studio-rail-drawer');
    const footerButton = screen.getByRole('button', { name: 'New Studio' });
    expect(footerButton.closest('div')?.className).toContain('border-t');
    const viewport = drawer.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport).not.toContainElement(footerButton);
  });

  it('paints every rail icon in the same secondary grey, as the desktop rail does', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByTestId('studio-rail-drawer');
    // The rail's own rows only, found by the shared row definition. The brand
    // mark keeps its colours on purpose and the close X belongs to the vendor
    // Sheet — neither is a rail row, so neither is this rule's business.
    const rows = [...drawer.querySelectorAll('a, button')].filter(
      (el) =>
        el.className.includes(RAIL_ROW_TOP) ||
        el.className.includes(RAIL_ROW_NESTED),
    );
    const icons = rows.flatMap((row) => [...row.querySelectorAll('svg')]);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.getAttribute('class')).toContain('text-muted-foreground');
    }
  });
});
