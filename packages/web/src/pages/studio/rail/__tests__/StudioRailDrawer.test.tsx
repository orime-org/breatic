// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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

  // The content and the foot are the same components the desktop rail renders,
  // so what is left for this host to get wrong is only what it writes itself:
  // the brand header, the hamburger, and where it puts the shared pieces. The
  // rule count below is not about drift — it is a cheap check that the shared
  // content actually mounted inside the drawer.

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
    expect(header?.className).toMatch(/(^|\s)mt-2(\s|$)/);
    expect(header?.className).not.toMatch(/(^|\s)pt-2(\s|$)/);
  });

  it('draws the same two rules the desktop rail does', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(
      screen.getByTestId('studio-rail-drawer').querySelectorAll('hr'),
    ).toHaveLength(2);
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

  it('paints the hamburger the same secondary grey the rail paints its icons', () => {
    // Only the parts this host owns are worth asserting here: the content and
    // the foot are the same components the desktop rail renders, and the
    // desktop tests check those. What is written twice is the hamburger — and
    // like every other icon-only chrome button in the rail, it takes that grey
    // from `chrome-ghost` rather than naming it.
    setup();
    const hamburger = screen.getByRole('button', { name: 'Open navigation' });
    expect(hamburger.className).toContain('text-muted-foreground');
    expect(hamburger.className).toContain('hover:text-foreground');
    expect(hamburger.querySelector('svg')?.getAttribute('class')).not.toMatch(
      /(^|\s)text-[a-z][\w-]*(\s|$)/,
    );
  });
});
