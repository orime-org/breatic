// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A Project that is still being copied, on the Studio page (inner#1706 design 5.4, acceptance 1). The grid card and the
 * list row follow one rule: while it is being copied it shows the spinner with "Copying", nothing about it opens the
 * Project or a join dialog, and it has no menu. Once the list reads it as copied, it is an ordinary card or row again.
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as React from 'react';
import type { ProjectSummary } from '@breatic/shared';

import { ProjectCard } from '@web/pages/studio/container/cards/ProjectCard';
import { hasCardMenu } from '@web/pages/studio/container/cards/ProjectCardMenu';
import type { ContainerProject } from '@web/pages/studio/container/container-types';
import { ProjectListBody } from '@web/pages/studio/container/ProjectListBody';
import { toContainerProject, type StudioProjectList } from '@web/pages/studio/container/use-studio-projects-paging';

const ALL_FLAGS = { canManageMeta: true, canDuplicate: true, canArchive: true, canRestore: false, canLeave: true };

/**
 * A listed Project, with the parts a case varies.
 * @param over - What differs.
 * @returns The Project.
 */
function project(over: Partial<ContainerProject> = {}): ContainerProject {
  return {
    id: 'copy-1',
    slug: 'storyboard-copy',
    name: 'Storyboard copy',
    thumbnailUrl: null,
    myRole: 'owner',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    archivedAt: null,
    lastOpenedAt: null,
    lastEditedAt: new Date(Date.now() - 60_000).toISOString(),
    ...ALL_FLAGS,
    copying: true,
    ...over,
  };
}

/**
 * A loaded list holding these Projects.
 * @param projects - The Projects.
 * @returns The list state.
 */
function listOf(projects: ContainerProject[]): StudioProjectList {
  return {
    projects, total: projects.length, isPending: false, firstPageFailed: false, retryFirstPage: () => {},
    isFetchingNextPage: false, hasNextPage: false, pageFailed: false, loadMore: () => {},
    sentinelRef: () => {}, scrollerRef: () => {},
  };
}

/**
 * Render inside the providers the Studio page has.
 * @param node - What to render.
 * @returns The render result.
 */
function show(node: React.ReactNode): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('a Project being copied, as a grid card', () => {
  it('shows "Copying", opens nothing and has no menu, whatever the viewer could otherwise do', () => {
    show(<ProjectCard project={project()} timeKind='created' />);
    const card = screen.getByTestId('project-card-copy-1');
    expect(within(card).getByText('Copying')).toBeInTheDocument();
    expect(within(card).queryByRole('link')).toBeNull();
    expect(within(card).queryAllByRole('button')).toEqual([]);
    fireEvent.click(within(card).getByText('Storyboard copy'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens no join dialog for a viewer who is not on it', () => {
    show(<ProjectCard project={project({ myRole: null, canManageMeta: false, canDuplicate: false, canArchive: false, canLeave: false })} timeKind='created' />);
    const card = screen.getByTestId('project-card-copy-1');
    expect(within(card).queryAllByRole('button')).toEqual([]);
    fireEvent.click(within(card).getByText('Storyboard copy'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is an ordinary card that links to the Project once it is copied', () => {
    show(<ProjectCard project={project({ copying: false })} timeKind='created' />);
    const card = screen.getByTestId('project-card-copy-1');
    expect(within(card).queryByText('Copying')).toBeNull();
    expect(within(card).getByRole('link')).toHaveAttribute('href', '/project/storyboard-copy-copy-1');
  });
});

describe('a Project being copied, as a list row', () => {
  it('shows "Copying", opens nothing and has no menu', () => {
    show(<ProjectListBody list={listOf([project(), project({ id: 'p-1', slug: 'storyboard', name: 'Storyboard', copying: false })])} archived={false} sort='opened' view='list' empty={null} />);
    const row = screen.getByTestId('project-row-copy-1');
    expect(within(row).getByText('Copying')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryAllByRole('button')).toEqual([]);
    const other = screen.getByTestId('project-row-p-1');
    expect(within(other).queryByText('Copying')).toBeNull();
    expect(within(other).getByRole('link')).toHaveAttribute('href', '/project/storyboard-p-1');
  });
});

describe('the rule both views share', () => {
  it('gives a Project being copied no menu, and one that is copied its usual menu', () => {
    expect(hasCardMenu(project())).toBe(false);
    expect(hasCardMenu(project({ copying: false }))).toBe(true);
  });

  it('carries whether a listed Project is being copied from the list answer', () => {
    const summary = {
      id: 'copy-1', studioId: 's-1', name: 'Storyboard copy', slug: 'storyboard-copy', thumbnailUrl: null, myRole: 'owner',
      createdAt: new Date(), updatedAt: new Date(), archivedAt: null, lastOpenedAt: null, lastEditedAt: new Date(),
      ...ALL_FLAGS, copying: true,
    } as ProjectSummary;
    expect(toContainerProject(summary).copying).toBe(true);
    expect(toContainerProject({ ...summary, copying: false }).copying).toBe(false);
  });
});
