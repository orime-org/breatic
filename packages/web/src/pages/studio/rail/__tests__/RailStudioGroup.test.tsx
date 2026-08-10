// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RailStudioGroup } from '@web/pages/studio/rail/RailStudioGroup';
import {
  RAIL_ICON,
  RAIL_INDENT_NESTED,
  RAIL_INDENT_TOP,
  RAIL_LIST,
  RAIL_ROW_NESTED,
} from '@web/pages/studio/rail/rail-row';
import type { StudioSummary } from '@web/pages/studio/shared/studio-types';

function studio(id: string, name: string): StudioSummary {
  return {
    id,
    slug: id,
    name,
    type: 'team',
    avatarUrl: null,
    bio: null,
    memberCount: 1,
    myStudioRole: 'admin',
  };
}

const STUDIOS = [studio('acme', 'Acme'), studio('nova', 'Nova Lab')];

/**
 * Render the group with the standard props, so each test states only what it
 * is about.
 * @param over - Props to override for this test.
 * @returns The render result.
 */
function renderGroup(over: Partial<React.ComponentProps<typeof RailStudioGroup>> = {}) {
  return render(
    <MemoryRouter>
      <RailStudioGroup
        title='My Studios'
        studios={STUDIOS}
        activeSlug={null}
        emptyText='none yet'
        collapseKey='rail.test.group'
        {...over}
      />
    </MemoryRouter>,
  );
}

describe('RailStudioGroup (rail ④⑤ — spec §4.2 / §4.3 / §0.1)', () => {
  beforeEach(() => window.localStorage.clear());

  it('renders each studio as a /studio/{slug} link and highlights the active one', () => {
    renderGroup({ activeSlug: 'nova' });

    const acme = screen.getByRole('link', { name: /Acme/ });
    expect(acme).toHaveAttribute('href', '/studio/acme');
    const nova = screen.getByRole('link', { name: /Nova Lab/ });
    expect(nova).toHaveAttribute('href', '/studio/nova');
    // The active studio is marked aria-current="page" exactly.
    expect(nova).toHaveAttribute('aria-current', 'page');
    expect(acme).not.toHaveAttribute('aria-current');
  });

  it('shows the empty text (never hides) when the group has no studios (§0.1 data-driven)', () => {
    renderGroup({ title: 'Joined Studios', studios: [], emptyText: '还没加入任何 studio' });

    // The section header stays AND the empty text is shown — not hidden.
    expect(screen.getByText('Joined Studios')).toBeInTheDocument();
    expect(screen.getByText('还没加入任何 studio')).toBeInTheDocument();
  });

  // ---- The collapse contract (user 2026-08-10) --------------------------
  // Collapsing answers to the chevron alone. The title is a label, not a
  // control: a whole row that lights up on hover reads as "this row goes
  // somewhere", and this one only opens and closes.

  it('does NOT collapse when the group title text is clicked', () => {
    renderGroup();

    fireEvent.click(screen.getByText('My Studios'));

    // Still expanded: the studios are all still there.
    expect(screen.getByRole('link', { name: /Acme/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Nova Lab/ })).toBeInTheDocument();
  });

  it('collapses and expands when the chevron button is clicked', () => {
    renderGroup();
    const toggle = screen.getByRole('button', { name: 'My Studios' });

    fireEvent.click(toggle);
    expect(screen.queryByRole('link', { name: /Acme/ })).toBeNull();
    expect(screen.getByText('My Studios')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: /Acme/ })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('names the chevron button after the group it controls, and points at the list', () => {
    const { container } = renderGroup();
    const toggle = screen.getByRole('button', { name: 'My Studios' });

    // The accessible name comes from the title element, so there is one
    // translated string and no second copy to keep in sync.
    const labelledBy = toggle.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(labelledBy!)}`)).toHaveTextContent(
      'My Studios',
    );

    const controls = toggle.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(controls!)}`)).toContainElement(
      screen.getByRole('link', { name: /Acme/ }),
    );
  });

  it('gives the chevron a 24px hit area of its own', () => {
    renderGroup();
    const toggle = screen.getByRole('button', { name: 'My Studios' });
    // --btn-compact, the smallest step on the chrome ladder.
    expect(toggle.className).toContain('h-6');
    expect(toggle.className).toContain('w-6');
  });

  // ---- The two-level hierarchy (spec 2026-06-07 §4.3) -------------------
  // A studio row sits one level under its group header, and the indent is the
  // whole of how that reads: 14px against the top level's 8px. Heights match.
  // A later "let's make every row line up" would flatten a deliberate tree.

  it('indents studio rows one level in, at the same height as a top-level row', () => {
    renderGroup();
    const row = screen.getByRole('link', { name: /Acme/ });
    expect(row.className).toContain(RAIL_ROW_NESTED);
    expect(row.className).toContain('pl-3.5');
    expect(row.className).toContain('h-8');
    expect(row.className).not.toContain('pl-2 ');
  });

  it('stacks studio rows with the same gap the top-level rows use', () => {
    // With no gap the filled backgrounds touch, so a selected row and the row
    // being hovered next to it read as one block rather than two.
    const { container } = renderGroup();
    const list = container.querySelector('ul');
    expect(list?.className).toContain(RAIL_LIST);
  });

  it('indents the empty text to the same level as a studio row', () => {
    // Standing in for the rows that are not there, it reads at their indent —
    // and takes that indent from the one place that owns it, so a later change
    // to the nesting cannot leave this line behind.
    renderGroup({ studios: [], emptyText: 'none yet' });
    expect(screen.getByText('none yet').className).toContain(RAIL_INDENT_NESTED);
  });

  it('aligns the heading with the top level it names, from the one indent', () => {
    renderGroup();
    expect(screen.getByText('My Studios').closest('div')?.className).toContain(
      RAIL_INDENT_TOP,
    );
  });

  it('brightens the current row’s icon rather than leaving it the quiet grey', () => {
    // Icons come up under the pointer; the row you are on has to read at least
    // as bright, or hovering a row you are not on lights it more than the one
    // you are.
    expect(RAIL_ICON).toContain('group-aria-[current=page]:text-foreground');
  });

  it('renders the group header as a quiet label, not a full-size row', () => {
    renderGroup();
    const title = screen.getByText('My Studios');
    // 11px + wider tracking: the studio names stay the loudest thing here.
    expect(title.className).toContain('text-2xs');
    expect(title.className).toContain('tracking-wider');
    // 28px header row against the 32px top-level rows.
    expect(title.closest('div')?.className).toContain('h-7');
  });
});
