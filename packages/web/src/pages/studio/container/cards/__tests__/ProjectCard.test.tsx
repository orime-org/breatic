// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

const project: ContainerProject = {
  id: 'id-1',
  slug: 'cyberpunk-alley',
  name: 'Cyberpunk Alley',
  thumbnailUrl: null,
  visibility: 'studio',
  myRole: 'owner',
  // Created 30 min ago → en renders a relative "30 minutes ago" label.
  createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
};

function setup(p: ContainerProject = project) {
  return render(
    <MemoryRouter>
      <ProjectCard project={p} studioRole='admin' />
    </MemoryRouter>,
  );
}

describe('ProjectCard', () => {
  it('renders the project name and links to /project/{slug}-{uuid}', () => {
    setup();
    expect(screen.getByText('Cyberpunk Alley')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/project/cyberpunk-alley-id-1',
    );
  });

  it('prefixes the time with the "created" label (the studio catalog shows creation time)', () => {
    // The container is a catalog: it shows the project's CREATION time (stable,
    // honest), not "modified" — canvas activity lives in Yjs and never bumps
    // the project row, so "modified" would mislead. The Recent landing handles
    // "what I recently opened" separately.
    setup();
    expect(screen.getByText(/^Created\b/i)).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
