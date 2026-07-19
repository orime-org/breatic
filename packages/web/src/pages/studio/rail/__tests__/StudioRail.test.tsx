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
  return { id, slug: id, name, type: 'team', memberCount: 1, myStudioRole: role };
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
      { id: 'me', slug: 'me', name: 'My Personal', type: 'personal' as const, memberCount: 1, myStudioRole: 'admin' as const },
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
