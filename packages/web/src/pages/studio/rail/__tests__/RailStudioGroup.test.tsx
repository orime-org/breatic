// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RailStudioGroup } from '@web/pages/studio/rail/RailStudioGroup';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

function studio(id: string, name: string): StudioSummary {
  return { id, slug: id, name, type: 'team', memberCount: 1, myStudioRole: 'admin' };
}

const STUDIOS = [studio('acme', 'Acme'), studio('nova', 'Nova Lab')];

describe('RailStudioGroup (rail ④⑤ — spec §4.2 / §0.1)', () => {
  beforeEach(() => window.localStorage.clear());

  it('renders each studio as a /studio/{slug} link and highlights the active one', () => {
    render(
      <MemoryRouter>
        <RailStudioGroup
          title='My Studios'
          studios={STUDIOS}
          activeSlug='nova'
          emptyText='none yet'
          collapseKey='rail.test.my'
        />
      </MemoryRouter>,
    );

    const acme = screen.getByRole('link', { name: /Acme/ });
    expect(acme).toHaveAttribute('href', '/studio/acme');
    const nova = screen.getByRole('link', { name: /Nova Lab/ });
    expect(nova).toHaveAttribute('href', '/studio/nova');
    // The active studio is marked aria-current="page" exactly.
    expect(nova).toHaveAttribute('aria-current', 'page');
    expect(acme).not.toHaveAttribute('aria-current');
  });

  it('shows the empty text (never hides) when the group has no studios (§0.1 data-driven)', () => {
    render(
      <MemoryRouter>
        <RailStudioGroup
          title='Joined Studios'
          studios={[]}
          activeSlug={null}
          emptyText='还没加入任何 studio'
          collapseKey='rail.test.joined'
        />
      </MemoryRouter>,
    );

    // The section header stays AND the empty text is shown — not hidden.
    expect(screen.getByText('Joined Studios')).toBeInTheDocument();
    expect(screen.getByText('还没加入任何 studio')).toBeInTheDocument();
  });

  it('collapses the list on header click (Discord-style), keeping the title', () => {
    render(
      <MemoryRouter>
        <RailStudioGroup
          title='My Studios'
          studios={STUDIOS}
          activeSlug={null}
          emptyText='none yet'
          collapseKey='rail.test.collapse'
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /Acme/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /My Studios/ }));

    // Collapsed: the list is gone, the title remains, aria-expanded flips.
    expect(screen.queryByRole('link', { name: /Acme/ })).toBeNull();
    expect(screen.getByText('My Studios')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /My Studios/ }),
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
