// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { StudioRail } from '@web/pages/studio/rail/StudioRail';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

function s(
  id: string,
  name: string,
  role: StudioSummary['myStudioRole'],
): StudioSummary {
  return {
    id,
    slug: id,
    name,
    type: 'team',
    avatarUrl: null,
    bio: null,
    memberCount: 1,
    myStudioRole: role,
  };
}

describe('StudioRail (spec §4 — invariant #1: renders exactly my studios, ④⑤ by role)', () => {
  beforeEach(() => window.localStorage.clear());

  it('renders all of the viewer’s studios as /studio/{slug} links (owned + joined)', () => {
    const studios = [
      s('me', 'My Personal', 'admin'),
      s('myteam', 'My Team', 'admin'),
      s('grant', 'Granted', 'maintainer'),
      s('join', 'Joined', 'guest'),
    ];
    render(
      <MemoryRouter>
        <StudioRail
          studios={studios}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /My Personal/ })).toHaveAttribute(
      'href',
      '/studio/me',
    );
    expect(screen.getByRole('link', { name: /My Team/ })).toHaveAttribute(
      'href',
      '/studio/myteam',
    );
    expect(screen.getByRole('link', { name: /Granted/ })).toHaveAttribute(
      'href',
      '/studio/grant',
    );
    expect(screen.getByRole('link', { name: /Joined/ })).toHaveAttribute(
      'href',
      '/studio/join',
    );
  });

  it('fires onCreateProject from the rail create entry', async () => {
    const onCreateProject = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={onCreateProject}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );

    // The first (enabled) create button is create-project; the others are
    // disabled placeholders.
    const enabled = screen
      .getAllByRole('button')
      .find((b) => !b.hasAttribute('disabled'));
    await userEvent.click(enabled!);
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('shows a distinct empty text for each of the three groups (#1090 / #1661)', () => {
    // All three groups are empty here; each must show ITS OWN empty text (the
    // #1090 bug was groups reusing one copy; #1661 split personal off as a
    // third group with its own empty state).
    render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('No personal Studio yet')).toBeInTheDocument();
    expect(screen.getByText('No team Studios yet')).toBeInTheDocument();
    expect(
      screen.getByText('You haven\'t joined any Studio yet'),
    ).toBeInTheDocument();
  });

  it('splits personal / my-team / joined into three groups (#1661)', () => {
    const studios = [
      {
        id: 'me',
        slug: 'me',
        name: 'My Personal',
        type: 'personal' as const,
        avatarUrl: null,
        bio: null,
        memberCount: 1,
        myStudioRole: 'admin' as const,
      },
      s('myteam', 'My Team', 'admin'),
      s('join', 'Joined', 'guest'),
    ];
    render(
      <MemoryRouter>
        <StudioRail
          studios={studios}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    // Three group headers render, top-to-bottom: Personal / My Team / Joined.
    const personal = screen.getByText('Personal Studio');
    const myTeam = screen.getByText('My Team Studios');
    const joined = screen.getByText('Joined Studios');
    expect(
      personal.compareDocumentPosition(myTeam) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      myTeam.compareDocumentPosition(joined) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The personal studio links, and is NOT under the team group.
    expect(screen.getByRole('link', { name: /My Personal/ })).toHaveAttribute(
      'href',
      '/studio/me',
    );
  });

  // ---- Visual rework, direction D (user 2026-08-10) ---------------------

  it('draws one rule inside the scroll area, not one between every segment', () => {
    // Five rules used to cut a 240px column into six pieces while every group
    // already carried a heading that said where it began. One rule is left,
    // and it separates two different kinds of thing: what you can do from
    // where you can go.
    const { container } = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(1);
  });

  it('breathes less above that rule than below it, as the demo does', () => {
    // The ratified demo pads the acting segment 8/8/6 and the navigating one
    // 12/8/8: the rule sits closer to what it closes than to what it opens.
    // With both segments on a flat 8 the rule reads as centred between two
    // equal blocks, which is not what was signed off.
    const { container } = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    const rule = container.querySelector('hr');
    expect(rule?.previousElementSibling?.className).toContain('pb-1.5');
    expect(rule?.nextElementSibling?.className).toContain('pt-3');
  });

  it('pins create-studio to the foot of the rail, outside the scrolling area', () => {
    // Creating a Studio is not the same act as creating something inside the
    // one you are in, and it must stay reachable however long the list grows.
    const { container } = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    const footer = screen.getByRole('button', { name: 'New Studio' }).closest('div');
    expect(footer?.className).toContain('border-t');
    // The scroll viewport must not contain it, or it would scroll away.
    const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
    expect(viewport).not.toContainElement(
      screen.getByRole('button', { name: 'New Studio' }),
    );
  });

  it('paints every rail icon in the same secondary grey', () => {
    // Three greys used to share the column: the clock quiet, the plus signs at
    // full strength, the group icons following their heading. An icon louder
    // than the words beside it is the thing that read as noise.
    const { container } = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    // Asserted on whatever actually colours each icon rather than on the icon's
    // own class list: `currentColor` resolves against the nearest ancestor that
    // names a colour, so a glyph with no colour of its own is painted by its
    // button. The `group-hover:` and `group-aria-` variants are not matched —
    // they are the hover and current states, not the resting colour.
    const RESTING_COLOUR = /(^|\s)(text-(?:muted-)?foreground)(\s|$)/;
    const painterOf = (icon: Element): string | null => {
      let el: Element | null = icon;
      while (el && el !== container) {
        const match = (el.getAttribute('class') ?? '').match(RESTING_COLOUR);
        if (match) return match[2];
        el = el.parentElement;
      }
      return null;
    };

    const icons = [...container.querySelectorAll('svg')];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(painterOf(icon)).toBe('text-muted-foreground');
    }
  });

  it('gives every top-level row the same weight, whatever element it is built on', () => {
    // Recent is a Link and the create actions are Buttons, and the Button
    // primitive's base carries font-medium. Unless the row definition names a
    // weight of its own, twMerge has nothing to override it with and the three
    // buttons render bolder than the link beside them — at exactly the weight
    // that marks the row you are currently on.
    render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug='somewhere-else'
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    for (const name of ['New project', 'New collection', 'New Studio']) {
      expect(screen.getByRole('button', { name }).className).not.toContain(
        'font-medium',
      );
    }
    expect(screen.getByRole('link', { name: /Recent/ }).className).not.toContain(
      'font-medium',
    );
  });

  it('keeps the bold weight for the row you are actually on', () => {
    render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    // activeSlug null means Recent is the current destination.
    expect(screen.getByRole('link', { name: /Recent/ }).className).toContain(
      'font-medium',
    );
  });

  it('fills the row you are on, and gives the others that fill only under the pointer', () => {
    // The one visible answer to "which studio am I in" is that block of fill.
    // Deleting it from RAIL_ROW_CURRENT left every test in this folder green,
    // because the assertions all compared a rendered row against the constant
    // that produced it — true no matter what the constant says.
    render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    const current = screen.getByRole('link', { name: /Recent/ });
    expect(current.className).toMatch(/(^|\s)bg-accent(\s|$)/);

    const idle = screen.getByRole('button', { name: 'New project' });
    expect(idle.className).toContain('hover:bg-accent');
    expect(idle.className).not.toMatch(/(^|\s)bg-accent(\s|$)/);
  });

  it('leaves 12px between the three groups, which is what tells them apart', () => {
    // Four of the five rules were removed on the grounds that the headings and
    // the space between the groups already say where each one begins. That
    // makes this gap load-bearing, and it had no test: setting it to zero left
    // every test green while the three groups read as one block.
    const { container } = render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    const groups = container.querySelector('hr')?.nextElementSibling;
    expect(groups?.className).toMatch(/(^|\s)gap-3(\s|$)/);
  });

  it('renders Recent at the TOP, above the create actions (visual spec 2026-06-08)', () => {
    render(
      <MemoryRouter>
        <StudioRail
          studios={[]}
          activeSlug={null}
          onCreateProject={vi.fn()}
          onCreateStudio={vi.fn()}
        />
      </MemoryRouter>,
    );
    const recent = screen.getByText('Recent');
    const createProject = screen.getByText('New project');
    // Recent must precede the create actions in DOM order (rail置顶).
    expect(
      recent.compareDocumentPosition(createProject) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
