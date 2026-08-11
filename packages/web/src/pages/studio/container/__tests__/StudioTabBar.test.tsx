// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  useLocation,
  useNavigationType,
} from 'react-router-dom';

import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioTabKey } from '@web/pages/studio/container/studio-tabs';
import type { StudioType } from '@web/pages/studio/shared/studio-types';

function setup(
  studioType: StudioType,
  {
    counts,
    current = 'projects',
    slug = 'acme-studio',
  }: {
    counts?: Partial<Record<StudioTabKey, number>>;
    current?: StudioTabKey;
    slug?: string;
  } = {},
) {
  return render(
    <MemoryRouter>
      <StudioTabBar
        studioType={studioType}
        counts={counts}
        current={current}
        slug={slug}
      />
    </MemoryRouter>,
  );
}

/**
 * Render the strip inside a router that reports where it is, so a test can
 * assert that focus movement did not navigate.
 * @param studioType - Whether the studio is personal or team.
 * @returns A reader for the current location.
 */
function setupWithLocation(studioType: StudioType): {
  location: () => { pathname: string; historyLength: number };
} {
  let read: () => { pathname: string; historyLength: number } = () => ({
    pathname: '',
    historyLength: 0,
  });
  function Probe(): React.JSX.Element {
    const loc = useLocation();
    const nav = useNavigationType();
    read = () => ({
      pathname: loc.pathname,
      // MemoryRouter's index is the number of entries behind the current one,
      // so an entry added by focus movement would show up here.
      historyLength: window.history.length,
    });
    // `nav` is read so the probe re-renders on every navigation.
    return <span data-testid='nav-type'>{nav}</span>;
  }
  render(
    <MemoryRouter initialEntries={['/studio/acme-studio']}>
      <StudioTabBar
        studioType={studioType}
        current='projects'
        slug='acme-studio'
      />
      <Probe />
    </MemoryRouter>,
  );
  return { location: () => read() };
}

// Each of these sections is a place with its own address — you can link to it,
// refresh into it, and walk back out of it. That makes the strip navigation,
// and navigation is links in a nav, not the ARIA tabs widget. The widget is
// for swapping panels inside one page: it moves focus with the arrow keys and
// activates whatever focus lands on, which is right when activating costs
// nothing and wrong when it writes a history entry. Both W3C's own tabs
// guidance (automatic activation is recommended precisely because panels are
// free to show) and the products shaped like this one point the same way —
// GitHub's organisation strip has no role="tab" on the page at all, just a
// <nav> of links.
describe('StudioTabBar — a nav of links, not a tablist', () => {
  it('renders no tab widget roles at all', () => {
    setup('team');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('renders every section as a link to its own address', () => {
    setup('team');
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      // The default section's address IS the studio's, not a second spelling
      // of it — otherwise the strip's first link points away from the page the
      // reader is already on.
      '/studio/acme-studio',
      '/studio/acme-studio/collections',
      '/studio/acme-studio/works',
      '/studio/acme-studio/members',
      '/studio/acme-studio/credits',
      '/studio/acme-studio/settings',
    ]);
  });

  it('names the current section with aria-current, and only that one', () => {
    setup('team', { current: 'members' });
    const current = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute(
      'href',
      '/studio/acme-studio/members',
    );
  });

  it('sits in a labelled nav landmark', () => {
    setup('team');
    // A landmark is how a screen-reader user jumps straight to this strip
    // instead of walking the page; unlabelled, several navs are
    // indistinguishable from one another.
    const nav = screen.getByRole('navigation', { name: 'Studio sections' });
    expect(nav).toBeInTheDocument();
  });

  it('moves focus between sections WITHOUT navigating', async () => {
    // This is the whole reason the widget was wrong. In a tablist the arrow
    // keys move focus and activate in one motion, so a keyboard user looking
    // along the strip left a history entry at every stop and had to press Back
    // once per keystroke to get out. Links do not activate on focus.
    //
    // What this asserts is the ADDRESS, not `aria-current`: that attribute is
    // computed from the `current` prop, which this test sets and never
    // changes, so asserting it stayed put would hold no matter what the strip
    // did on focus. The address is the thing a regression would move.
    const user = userEvent.setup();
    const { location } = setupWithLocation('team');
    const links = screen.getAllByRole('link');
    links[0]?.focus();

    await user.tab();

    expect(document.activeElement).toBe(links[1]);
    expect(location().pathname).toBe('/studio/acme-studio');
    expect(location().historyLength).toBe(1);
  });

  it('navigates on Enter, once', async () => {
    // The other half of the same fact: focus moves without going anywhere, and
    // going somewhere takes a deliberate press. Together they are what a
    // tablist could not give.
    const user = userEvent.setup();
    const { location } = setupWithLocation('team');
    screen.getAllByRole('link')[1]?.focus();

    await user.keyboard('{Enter}');

    expect(location().pathname).toBe('/studio/acme-studio/collections');
  });

  it('renders all 6 sections for a team studio, in spec order', () => {
    setup('team');
    // Test boot locale is English (vitest.setup seeds en + setLocale('en')).
    // Works sits at the 3rd position (spec §6.1), not the end.
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Projects',
      'Collections',
      'Works',
      'Members',
      'Credits',
      'Settings',
    ]);
  });

  it('shows all 6 sections for a personal studio (Members read-only, A 方案)', () => {
    setup('personal');
    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(
      screen.getByRole('link', { name: 'Members' }),
    ).toBeInTheDocument();
  });

  it('shows a count chip only for the sections given one', () => {
    setup('team', { counts: { projects: 3, members: 12 } });
    // The chip is a sibling element inside the link, so the computed name runs
    // the two together ("Projects3") — matched on the label, with the number
    // asserted separately below.
    expect(screen.getByRole('link', { name: /Projects/ })).toHaveTextContent(
      'Projects3',
    );
    expect(screen.getByRole('link', { name: /Members/ })).toHaveTextContent(
      'Members12',
    );
    // Settings was given no count, so it carries no chip.
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });
});
