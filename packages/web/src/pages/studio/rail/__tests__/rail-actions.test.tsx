// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { RailCreateActions } from '@web/pages/studio/rail/RailCreateActions';
import { RailRecentLink } from '@web/pages/studio/rail/RailRecentLink';

describe('RailCreateActions (spec §4.1 ①②)', () => {
  it('fires onCreateProject when create-project is clicked', () => {
    const onCreateProject = vi.fn();
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        createStudioLabel='New studio'
        comingSoonLabel='Coming soon'
        onCreateProject={onCreateProject}
        onCreateStudio={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('fires onCreateStudio when create-studio is clicked', () => {
    const onCreateStudio = vi.fn();
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        createStudioLabel='New studio'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
        onCreateStudio={onCreateStudio}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New studio' }));
    expect(onCreateStudio).toHaveBeenCalledTimes(1);
  });

  it('renders create-collection as a disabled placeholder (backend deferred)', () => {
    render(
      <RailCreateActions
        createProjectLabel='New project'
        createCollectionLabel='New collection'
        createStudioLabel='New studio'
        comingSoonLabel='Coming soon'
        onCreateProject={vi.fn()}
        onCreateStudio={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'New collection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New studio' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'New project' })).toBeEnabled();
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
});
