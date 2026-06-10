// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import { CollectionCard } from '@web/pages/studio/container/cards/CollectionCard';
import type {
  ContainerCollection,
  ContainerProject,
} from '@web/pages/studio/container/container-types';
import type { StudioRole } from '@web/pages/studio/shared/studio-types';

const OWNED_PRIVATE: ContainerProject = {
  id: 'p1',
  slug: 'secret',
  name: 'Secret Project',
  thumbnailUrl: null,
  visibility: 'private',
  myRole: 'owner',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const SHARED_STUDIO: ContainerProject = {
  id: 'p2',
  slug: 'shared',
  name: 'Shared Project',
  thumbnailUrl: null,
  visibility: 'studio',
  myRole: 'editor',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

function renderProject(project: ContainerProject, studioRole: StudioRole) {
  return render(
    <MemoryRouter>
      <ProjectCard project={project} studioRole={studioRole} />
    </MemoryRouter>,
  );
}

const MORE = { name: 'More actions' };

describe('ProjectCard (spec §3.3 + invariant 2 governance gating)', () => {
  it('renders name + badges and links to /project/{slug}-{uuid}', () => {
    renderProject(SHARED_STUDIO, 'member');
    expect(screen.getByText('Shared Project')).toBeInTheDocument();
    expect(screen.getByText('Studio-visible')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/project/shared-p2',
    );
  });

  it('shows the governance menu to the project owner', () => {
    renderProject(OWNED_PRIVATE, 'member');
    expect(screen.getByRole('button', MORE)).toBeInTheDocument();
  });

  it('hides the governance menu from a non-owner member', () => {
    renderProject(SHARED_STUDIO, 'member');
    expect(screen.queryByRole('button', MORE)).toBeNull();
  });

  it('shows the governance menu to a studio admin even when not owner', () => {
    renderProject(SHARED_STUDIO, 'admin');
    expect(screen.getByRole('button', MORE)).toBeInTheDocument();
  });

  it('renders the baseline viewer role when myRole is null', () => {
    renderProject({ ...SHARED_STUDIO, myRole: null }, 'member');
    expect(screen.getByText('Viewer')).toBeInTheDocument();
  });

  it('cardmenu overlay matches the neutral mock (chrome radius, 7px inset, 70% black hover)', () => {
    renderProject(OWNED_PRIVATE, 'member');
    const menu = screen.getByRole('button', MORE);
    // Neutral mock `.cardmenu` was 2px; the design-system rebuild's unified
    // radius scale conforms all chrome affordances to --radius-chrome (6px) via
    // rounded-chrome (see lint:no-raw-design-values). Inset 7px and the default
    // rgba(0,0,0,.45) -> hover rgba(0,0,0,.7) are unchanged. The 70% black hover
    // is permitted by lint:hover (black is a fixed color, not a mode-aware token).
    expect(menu.className).toContain('rounded-chrome');
    expect(menu.className).toContain('right-[7px]');
    expect(menu.className).toContain('top-[7px]');
    expect(menu.className).toContain('bg-black/45');
    expect(menu.className).toContain('hover:bg-black/70');
  });
});

const MOODBOARD: ContainerCollection = {
  id: 'c1',
  slug: 'moodboard',
  name: 'Moodboard',
  previewThumbnails: [],
  assetCount: 24,
  kind: 'image',
  visibility: 'studio',
  myRole: 'editor',
};

describe('CollectionCard (spec §3.4)', () => {
  it('renders name + asset count (no kind tag, per定稿) and links to /collection/{slug}-{uuid}', () => {
    render(
      <MemoryRouter>
        <CollectionCard collection={MOODBOARD} studioRole='member' />
      </MemoryRouter>,
    );
    expect(screen.getByText('Moodboard')).toBeInTheDocument();
    expect(screen.getByText(/24 assets/)).toBeInTheDocument();
    // The media-kind tag was dropped from the card in the locked mock
    // (2026-06-06 iteration — title row is just name + asset count).
    expect(screen.queryByText('Image')).toBeNull();
    expect(screen.getByText('Studio-visible')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/collection/moodboard-c1',
    );
  });

  it('cardmenu overlay matches the neutral mock (chrome radius, 7px inset, 70% black hover) — peer-consistent with ProjectCard', () => {
    // An admin can manage any item, so the governance menu renders. The
    // collection card's overlay must match the project card's: the neutral
    // mock `.cardmenu` is identical across project/collection peers (radius
    // conformed to --radius-chrome by the design-system rebuild).
    render(
      <MemoryRouter>
        <CollectionCard collection={MOODBOARD} studioRole='admin' />
      </MemoryRouter>,
    );
    const menu = screen.getByRole('button', MORE);
    expect(menu.className).toContain('rounded-chrome');
    expect(menu.className).toContain('right-[7px]');
    expect(menu.className).toContain('top-[7px]');
    expect(menu.className).toContain('bg-black/45');
    expect(menu.className).toContain('hover:bg-black/70');
  });
});

