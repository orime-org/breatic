// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router-dom';

import { StudioTabBar } from '@web/pages/studio/container/StudioTabBar';
import type { StudioTabKey } from '@web/pages/studio/container/studio-tabs';
import type {
  StudioRole,
  StudioType,
} from '@web/pages/studio/shared/studio-types';

function setup(
  studioType: StudioType,
  {
    counts,
    current = 'projects',
    slug = 'acme-studio',
    viewerRole = 'admin',
  }: {
    counts?: Partial<Record<StudioTabKey, number>>;
    current?: StudioTabKey;
    slug?: string;
    viewerRole?: StudioRole;
  } = {},
) {
  return render(
    <MemoryRouter>
      <StudioTabBar
        studioType={studioType}
        viewerRole={viewerRole}
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
  location: () => { pathname: string; entryKey: string };
  goBack: () => void;
} {
  let read: () => { pathname: string; entryKey: string } = () => ({
    pathname: '',
    entryKey: '',
  });
  let back: () => void = () => {};
  function Probe(): React.JSX.Element {
    const loc = useLocation();
    const nav = useNavigationType();
    const navigate = useNavigate();
    read = () => ({
      pathname: loc.pathname,
      // NOT `window.history.length`: MemoryRouter keeps its stack in memory and
      // never writes to the browser's, so that number stays 1 whatever happens
      // and an assertion on it can never fail. `key` changes on every entry
      // the router pushes, so it does move when a navigation occurs.
      entryKey: loc.key,
    });
    // One step back through the router's own stack — the test's stand-in for
    // the browser's Back button, which is where "once" is actually felt.
    back = () => navigate(-1);
    // `nav` is read so the probe re-renders on every navigation.
    return <span data-testid='nav-type'>{nav}</span>;
  }
  render(
    <MemoryRouter initialEntries={['/studio/acme-studio']}>
      <StudioTabBar
        studioType={studioType}
        viewerRole='admin'
        current='projects'
        slug='acme-studio'
      />
      <Probe />
    </MemoryRouter>,
  );
  return { location: () => read(), goBack: () => act(() => back()) };
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

  it('marks the current section so it LOOKS different, not only reads different', () => {
    // `aria-current` is for the machine. A sighted reader needs the strip to
    // show which section they are in, and asserting the attribute cannot see
    // whether anything paints — which is how the indicator went missing: the
    // classes were concatenated, so `border-transparent` and
    // `text-muted-foreground` from the shared base beat the overrides on
    // source order and every link rendered identically.
    setup('team', { current: 'members' });
    const links = screen.getAllByRole('link');
    const current = links.find(
      (l) => l.getAttribute('aria-current') === 'page',
    );
    const others = links.filter((l) => l !== current);

    // The override must have survived the merge, and its loser must be gone.
    expect(current?.className).toContain('border-active-border');
    expect(current?.className).not.toContain('border-transparent');
    expect(current?.className).toContain('text-foreground');
    expect(current?.className).not.toContain('text-muted-foreground');
    // And the others must still carry what the current one dropped.
    for (const other of others) {
      expect(other.className).toContain('border-transparent');
      expect(other.className).toContain('text-muted-foreground');
    }
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
    // This is the whole reason the widget was wrong FOR THIS STRIP. In a
    // tablist the arrow keys move focus and activate in one motion — free when
    // activating swaps a panel already loaded, which is why W3C recommends it.
    // Once the section is an address, the same motion would write a history
    // entry at every stop and a keyboard user looking along the strip would
    // need one Back per keystroke to get out. Links do not activate on focus.
    //
    // What this asserts is the ADDRESS, not `aria-current`: that attribute is
    // computed from the `current` prop, which this test sets and never
    // changes, so asserting it stayed put would hold no matter what the strip
    // did on focus. The address is the thing a regression would move.
    const user = userEvent.setup();
    const { location } = setupWithLocation('team');
    const links = screen.getAllByRole('link');
    const keyBefore = location().entryKey;
    links[0]?.focus();

    await user.tab();

    expect(document.activeElement).toBe(links[1]);
    expect(location().pathname).toBe('/studio/acme-studio');
    // Same history entry as before the keypress — no navigation happened.
    expect(location().entryKey).toBe(keyBefore);
  });

  it('navigates on Enter, once — one press in, one Back out', async () => {
    // The other half of the same fact: focus moves without going anywhere, and
    // going somewhere takes a deliberate press. Together they are what a
    // tablist could not give.
    //
    // "Once" is the load-bearing word, and what it promises the reader is that
    // one press in costs one Back out. Asserting the destination alone says
    // nothing about that: the address is right whether the press left the
    // previous page reachable or replaced it, and the reader only finds out
    // when Back does not take them home. Pressing Back is the only way to ask.
    //
    // Not counted, pressed. Counting entries would need a number the router
    // does not expose — `window.history.length` is inert under MemoryRouter —
    // and it would also be measuring the wrong thing: a second push of the SAME
    // address is not even possible here, because a `<Link>` whose target equals
    // the current location replaces rather than pushes (verified against the
    // installed react-router). What a reader can actually be robbed of is the
    // page they came from.
    const user = userEvent.setup();
    const { location, goBack } = setupWithLocation('team');
    screen.getAllByRole('link')[1]?.focus();

    await user.keyboard('{Enter}');
    expect(location().pathname).toBe('/studio/acme-studio/collections');

    goBack();

    expect(location().pathname).toBe('/studio/acme-studio');
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
