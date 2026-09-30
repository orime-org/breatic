// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

vi.mock('@web/data/api/project-join-requests', () => ({
  projectJoinRequestsApi: {
    mine: () =>
      Promise.resolve({
        project: { id: 'id-1', name: 'Cyberpunk Alley', studioSlug: 'acme' },
        pendingRequest: null,
      }),
    request: vi.fn(),
    cancelMine: vi.fn(),
  },
}));

const project: ContainerProject = {
  id: 'id-1',
  slug: 'cyberpunk-alley',
  name: 'Cyberpunk Alley',
  thumbnailUrl: null,
  myRole: 'owner',
  // Created 30 min ago → en renders a relative "30 minutes ago" label.
  createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
};

function setup(p: ContainerProject = project) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectCard project={p} studioSlug='acme' />
      </MemoryRouter>
    </QueryClientProvider>,
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

  it('uses the same card body as the Recent landing: 13px name, one meta line with the role as text', () => {
    setup();
    expect(screen.getByText('Cyberpunk Alley').className).toMatch(
      /\btext-sm\b.*\bfont-medium\b/,
    );
    const meta = screen.getByTestId('item-card-meta');
    expect(meta).toContainElement(screen.getByText(/^Created\b/));
    const role = screen.getByText('Owner');
    expect(meta).toContainElement(role);
    expect(role.tagName).toBe('SPAN');
    expect(role.className).not.toMatch(/\bbg-/);
  });

  it('shows the built-in default cover when the project has no cover', () => {
    setup();
    const cover = screen.getByRole('link').firstElementChild;
    expect(cover?.querySelector('[data-testid="default-project-cover"]')).not.toBeNull();
    expect(cover?.querySelector('img')).toBeNull();
  });

  it('shows the uploaded cover instead of the default one', () => {
    setup({ ...project, thumbnailUrl: 'https://cdn.test/cover.jpg' });
    const cover = screen.getByRole('link').firstElementChild;
    expect(cover?.querySelector('img')).toHaveAttribute('src', 'https://cdn.test/cover.jpg');
    expect(cover?.querySelector('[data-testid="default-project-cover"]')).toBeNull();
  });

  it('offers the project owner an "Upload cover" entry behind the ⋯ menu', async () => {
    setup();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Upload cover' })).toBeInTheDocument();
  });

  it('shows no ⋯ menu to a member who does not own the project', () => {
    setup({ ...project, myRole: 'editor' });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('opens the join dialog in place for a project the viewer is not on', async () => {
    setup({ ...project, myRole: null });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText('Owner')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: /Cyberpunk Alley/ }));

    expect(await screen.findByTestId('join-project-dialog')).toBeInTheDocument();
    expect(screen.getByText('You\'re not a member of this project')).toBeInTheDocument();
  });

  it('has no a11y violations', async () => {
    const { container } = setup();
    await expectNoA11yViolations(container);
  });
});
