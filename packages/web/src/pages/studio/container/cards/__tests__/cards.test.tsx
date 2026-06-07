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
  isOwner: true,
};

const SHARED_STUDIO: ContainerProject = {
  id: 'p2',
  slug: 'shared',
  name: 'Shared Project',
  thumbnailUrl: null,
  visibility: 'studio',
  myRole: 'editor',
  isOwner: false,
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
  isOwner: false,
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
});

