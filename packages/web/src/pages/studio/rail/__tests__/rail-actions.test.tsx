// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RailCreateActions } from '@web/pages/studio/rail/RailCreateActions';
import { RailRecentLink } from '@web/pages/studio/rail/RailRecentLink';
import { RAIL_LIST, RAIL_ROW_TOP } from '@web/pages/studio/rail/rail-row';

describe('RailCreateActions (spec §4.1 ①②)', () => {
  it('fires onCreateProject when create-project is clicked', () => {
    const onCreateProject = vi.fn();
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={onCreateProject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('renders create-collection as a disabled placeholder (backend deferred)', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );

    // Disabled through the HTML attribute — never `pointer-events: none`,
    // which would swallow the hover that explains why it cannot be used.
    const collection = screen.getByRole('button', { name: 'New collection' });
    expect(collection).toBeDisabled();
    expect(collection.className).toContain('cursor-not-allowed');
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled();
  });

  it('no longer carries the create-studio action (it lives in the rail footer)', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('draws no separator of its own', () => {
    const { container } = render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('hr')).toHaveLength(0);
  });

  it('stacks its actions with the one list definition', () => {
    const { container } = render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    expect(container.firstElementChild?.className).toContain(RAIL_LIST);
  });

  it('builds both actions from the one top-level row definition', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
      />,
    );
    for (const name of ['New project', 'New collection']) {
      expect(screen.getByRole('button', { name }).className).toContain(RAIL_ROW_TOP);
    }
  });
});

describe('RailRecentLink (spec §4.1 ③)', () => {
  it('links to /studio and highlights when active', () => {
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /Recent/ });
    expect(link).toHaveAttribute('href', '/studio');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark aria-current when not active', () => {
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Recent/ })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('is a top-level rail row, from the one definition', () => {
    render(
      <MemoryRouter>
        <RailRecentLink label='Recent' active={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Recent/ }).className).toContain(
      RAIL_ROW_TOP,
    );
  });
});
