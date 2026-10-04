// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { projectsApi } from '@web/data/api/projects';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

vi.mock('@web/data/api/projects', () => ({
  projectsApi: {
    rename: vi.fn(() => Promise.resolve({ name: 'Renamed' })),
    duplicate: vi.fn(() => Promise.resolve({ name: 'Copy of Cyberpunk Alley' })),
    archive: vi.fn(() => Promise.resolve({ ok: true })),
    restore: vi.fn(() => Promise.resolve({ ok: true })),
  },
}));

vi.mock('@web/data/api/project-join-requests', () => ({
  projectJoinRequestsApi: {
    mine: () =>
      Promise.resolve({
        project: { id: 'id-1', name: 'Cyberpunk Alley', studioSlug: 'acme', archivedAt: null },
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
  archivedAt: null,
  canManageMeta: true,
  canDuplicate: true,
  canArchive: false,
  canRestore: false,
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

  it('lists rename, cover and duplicate for an owner or editor, and no archive', async () => {
    setup();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate']);
  });

  it('lists rename, cover and archive for a studio admin who is not on the project', async () => {
    setup({ ...project, myRole: null, canDuplicate: false, canArchive: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Archive']);
  });

  it('shows no ⋯ menu when the viewer may do none of it', () => {
    setup({ ...project, myRole: 'viewer', canManageMeta: false, canDuplicate: false });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('renames through the dialog', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const field = await screen.findByLabelText('Name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(field);
    await user.type(field, '  Renamed  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(projectsApi.rename).toHaveBeenCalledWith('id-1', 'Renamed');
    expect(screen.queryByTestId('rename-project-dialog')).toBeNull();
  });

  it('duplicates straight from the menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));
    expect(projectsApi.duplicate).toHaveBeenCalledWith('id-1');
  });

  it('archives only after the confirmation', async () => {
    const user = userEvent.setup();
    setup({ ...project, canArchive: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    const dialog = await screen.findByTestId('archive-project-dialog');
    expect(dialog).toHaveTextContent('Archive “Cyberpunk Alley”?');
    expect(projectsApi.archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(projectsApi.archive).toHaveBeenCalledWith('id-1');
  });

  describe('an archived card', () => {
    const archived: ContainerProject = {
      ...project,
      archivedAt: '2026-10-01T00:00:00.000Z',
      canManageMeta: false,
      canDuplicate: false,
      canRestore: true,
    };

    it('carries the archived badge and offers only restore', async () => {
      const user = userEvent.setup();
      setup(archived);
      expect(screen.getByText('Archived')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'More actions' }));
      const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
      expect(items).toEqual(['Restore']);
      await user.click(screen.getByRole('menuitem', { name: 'Restore' }));
      expect(projectsApi.restore).toHaveBeenCalledWith('id-1');
    });

    it('still opens for a member', () => {
      setup(archived);
      expect(screen.getByRole('link')).toHaveAttribute('href', '/project/cyberpunk-alley-id-1');
    });

    it('is not clickable for an admin who is not on the project', () => {
      setup({ ...archived, myRole: null });
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('button', { name: /Cyberpunk Alley/ })).toBeNull();
    });
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
