// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { StudioSwitcherPanel } from '@web/pages/studio/shell/StudioSwitcherPanel';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

// Deliberately NOT personal-first, to prove the panel hoists personal itself.
const STUDIOS: readonly StudioSummary[] = [
  {
    id: 's-acme',
    slug: 'acme-studio',
    name: 'Acme Studio',
    type: 'team',
    memberCount: 4,
    myStudioRole: 'member',
  },
  {
    id: 's-alex',
    slug: 'alex',
    name: 'Alex',
    type: 'personal',
    memberCount: 1,
    myStudioRole: 'admin',
  },
  {
    id: 's-nova',
    slug: 'nova-lab',
    name: 'Nova Lab',
    type: 'team',
    memberCount: 3,
    myStudioRole: 'member',
  },
];

function setup(activeSlug: string | null, guestProjectCount = 2) {
  return render(
    <MemoryRouter>
      <StudioSwitcherPanel
        studios={STUDIOS}
        activeSlug={activeSlug}
        guestProjectCount={guestProjectCount}
      />
    </MemoryRouter>,
  );
}

/** Studio rows are the links targeting `/studio/{slug}` (excludes the Recent link). */
function studioRowNames(): string[] {
  return screen
    .getAllByRole('link')
    .filter((a) => /\/studio\/.+/.test(a.getAttribute('href') ?? ''))
    .map((a) => a.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

describe('StudioSwitcherPanel (invariant §4 switcher state)', () => {
  it('lists the Recent entry plus every own studio', () => {
    setup('acme-studio');
    // Recent link + 3 studio links = 4 links.
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.getByRole('link', { name: /Recent/ })).toHaveAttribute(
      'href',
      '/studio',
    );
  });

  it('orders the personal studio first regardless of input order', () => {
    setup('acme-studio');
    expect(studioRowNames()[0]).toContain('Alex');
  });

  it('highlights exactly one active destination (the active studio)', () => {
    const { container } = setup('acme-studio');
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/studio/acme-studio');
  });

  it('highlights Recent (only) when no studio is active', () => {
    const { container } = setup(null);
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute('href', '/studio');
  });

  it('shows the guest project count without adding guest studio rows', () => {
    setup('acme-studio', 5);
    // ICU "{count} shared projects" → "5 shared projects".
    expect(screen.getByText(/5 shared projects/)).toBeInTheDocument();
    // Still only the 3 own studios as rows — guests are a count, not rows.
    expect(studioRowNames()).toHaveLength(3);
  });
});
