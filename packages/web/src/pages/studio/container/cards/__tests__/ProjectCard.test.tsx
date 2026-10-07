// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { projectsApi } from '@web/data/api/projects';
import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import type { ProjectTimeKind } from '@web/pages/studio/container/container-types';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

vi.mock('@web/data/api/projects', () => ({
  projectsApi: {
    rename: vi.fn(() => Promise.resolve({ name: 'Renamed' })),
    duplicate: vi.fn(() => Promise.resolve({ name: 'Copy of Cyberpunk Alley' })),
    archive: vi.fn(() => Promise.resolve({ ok: true })),
    restore: vi.fn(() => Promise.resolve({ ok: true })),
    leave: vi.fn(() => Promise.resolve({ ok: true })),
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
  lastOpenedAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  lastEditedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
  canManageMeta: true,
  canDuplicate: true,
  canArchive: false,
  canRestore: false,
  canLeave: false,
};

// The flags the server sends for each caller on a live project
// (projectGovernance: the studio admin and the owner manage, only the admin archives).
const AS_STUDIO_ADMIN = { canManageMeta: true, canDuplicate: true, canArchive: true, canRestore: false, canLeave: false };
const AS_NOBODY = { canManageMeta: false, canDuplicate: false, canArchive: false, canRestore: false, canLeave: false };
const AS_EDITOR = { ...AS_NOBODY, canLeave: true };

function setup(p: ContainerProject = project, timeKind: ProjectTimeKind = 'created') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ProjectCard project={p} timeKind={timeKind} />
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

  it('shows the time the list is sorted by', () => {
    setup(project, 'opened');
    expect(screen.getByText('Opened 5 minutes ago')).toBeInTheDocument();
  });

  it('says a project was never opened, with its creation time, under the last-opened sort', () => {
    setup({ ...project, lastOpenedAt: null }, 'opened');
    expect(screen.getByText('Never opened · Created 30 minutes ago')).toBeInTheDocument();
  });

  it('shows the edit time under the last-edited sort', () => {
    setup(project, 'edited');
    expect(screen.getByText('Edited 10 minutes ago')).toBeInTheDocument();
  });

  it('shows the archive time on an archived card under the archive sort', () => {
    setup({ ...project, archivedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString() }, 'archived');
    expect(screen.getByText('Archived 2 hours ago')).toBeInTheDocument();
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

  it('lists rename, cover and duplicate for the project owner, and no archive', async () => {
    setup();
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate']);
  });

  it('lists rename, cover, duplicate and archive for a studio admin who is not on the project', async () => {
    setup({ ...project, myRole: null, ...AS_STUDIO_ADMIN });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate', 'Archive']);
  });

  it('shows no ⋯ menu when the viewer may do none of it', () => {
    setup({ ...project, myRole: 'viewer', ...AS_NOBODY });
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('offers an editor only Leave project', async () => {
    setup({ ...project, myRole: 'editor', ...AS_EDITOR });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Leave project']);
    expect(screen.getByRole('menuitem', { name: 'Leave project' })).toHaveClass('text-status-error-foreground');
  });

  it('puts Leave project last, after a separator, for a studio admin who is also an editor', async () => {
    setup({ ...project, myRole: 'editor', ...AS_STUDIO_ADMIN, canLeave: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'More actions' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual(['Rename', 'Upload cover', 'Duplicate', 'Archive', 'Leave project']);
    const leave = screen.getByRole('menuitem', { name: 'Leave project' });
    expect(leave.previousElementSibling?.getAttribute('role')).toBe('separator');
  });

  it('leaves only after the confirmation, and cancelling changes nothing', async () => {
    const user = userEvent.setup();
    setup({ ...project, myRole: 'viewer', ...AS_EDITOR });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave project' }));
    const dialog = await screen.findByTestId('leave-project-dialog');
    expect(dialog).toHaveTextContent('Leave “Cyberpunk Alley”?');
    expect(dialog).toHaveTextContent('You won\'t be able to open this project after leaving.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(projectsApi.leave).not.toHaveBeenCalled();
    expect(screen.queryByTestId('leave-project-dialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Leave project' }));
    const confirm = await screen.findByRole('button', { name: 'Leave' });
    expect(confirm).toHaveClass('text-status-error-foreground');
    await user.click(confirm);
    expect(projectsApi.leave).toHaveBeenCalledWith('id-1');
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
    setup({ ...project, ...AS_STUDIO_ADMIN });
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
    setup({ ...project, myRole: null, ...AS_NOBODY });
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
