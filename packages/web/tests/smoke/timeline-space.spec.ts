// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Real Timeline creation and common Space lifecycle entry points (inner#1707). */
import { expect, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import {
  archiveProjects,
  MADE_BY_SMOKE,
  openSmokeProject,
  smokeProjectId,
} from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

/**
 * Assert the real Timeline body belongs to the expected Project and Space.
 * @throws {Error} When the initialized Timeline or its editing controls never appear.
 */
async function expectEmptyTimeline(page: Page, projectId: string, spaceId: string, expectDirectoryRead = true): Promise<void> {
  const outlet = visibleSpace(page);
  await expect(outlet).toHaveAttribute('data-space-outlet', spaceId);
  const timeline = outlet.getByTestId('timeline-space');
  await expect(timeline).toHaveAttribute('data-project-id', projectId);
  await expect(timeline).toHaveAttribute('data-space-id', spaceId);
  await expect(timeline.getByTestId('timeline-space-empty')).toBeVisible();
  await expect(timeline.getByTestId('timeline-track-visual-1')).toBeVisible();
  await expect(timeline.getByTestId('timeline-add-media')).toBeEnabled();
  await expect(timeline.locator('[data-testid^="timeline-clip-"]')).toHaveCount(0);
  // A positive initialized body anchors these absence assertions after synchronization.
  await expect(outlet.getByTestId('timeline-space-loading')).toHaveCount(0);
  await expect(outlet.getByTestId('timeline-space-error')).toHaveCount(0);
  await expect(outlet.getByTestId('timeline-space-unavailable')).toHaveCount(0);
  await expect(page.getByTestId('loading-screen')).toHaveCount(0);

  // Reopening within the existing query stale time reuses the already-authorized directory.
  const directoryResponse = expectDirectoryRead ? page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === 'GET'
      && url.pathname === `/api/v1/projects/${projectId}/assets`
      && url.searchParams.get('kind') === 'video';
  }) : null;
  const addMedia = timeline.getByTestId('timeline-add-media');
  await addMedia.click();
  const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
  await expect(dialog).toBeVisible();
  const projectVideos = dialog.getByTestId('timeline-material-project');
  await expect(projectVideos).toHaveText('Project videos');
  await expect(projectVideos).toBeEnabled();
  await expect(projectVideos).toHaveAttribute('aria-pressed', 'true');
  if (directoryResponse !== null) {
    const response = await directoryResponse;
    expect(response.status(), `read Project ${projectId} video directory`).toBe(200);
    await response.finished();
  }
  await expect(dialog.getByText('Loading Project videos…', { exact: true })).toHaveCount(0);
  await expect(dialog.getByTestId('timeline-material-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(addMedia).toBeFocused();
}

test('creating a Project with a keyboard-selected Timeline opens its initialized empty Space', async ({ page }) => {
  const anchor = await dataOf<{ studioId: string }>(
    await page.request.get(`/api/v1/projects/${smokeProjectId()}`),
    'read the slot Project scope',
  );
  const studios = await dataOf<{ id: string; slug: string; name: string }[]>(
    await page.request.get('/api/v1/studios'),
    'list the slot account Studios',
  );
  const studio = studios.find((candidate) => candidate.id === anchor.studioId);
  if (studio === undefined) throw new Error('the slot Project Studio is missing');

  const stamp = Date.now();
  const name = `Smoke run timeline project ${stamp}`;
  const slug = `${MADE_BY_SMOKE}-timeline-project-${stamp}`;
  let createdProjectId: string | null = null;
  try {
    await page.goto(`/studio/${studio.slug}/projects`);
    await page.getByTestId('container-toolbar').getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByTestId('new-project-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#new-project-studio')).toHaveText(studio.name);
    await dialog.locator('#new-project-name').fill(name);
    await expect(dialog.locator('#new-project-slug')).toHaveValue(slug);

    const timelineChoice = dialog.getByTestId('new-project-type-timeline');
    await timelineChoice.press('Space');
    await expect(timelineChoice).toHaveAttribute('aria-checked', 'true');
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/projects',
    );
    await dialog.getByRole('button', { name: 'Create', exact: true }).press('Enter');
    const response = await responsePromise;
    expect(response.ok(), `create Timeline Project: ${response.status()}`).toBe(true);
    const { data: created } = await response.json() as { data: { id: string; studioId: string } };
    // Capture the accepted identity before later UI assertions, so a rendering failure is cleaned up too.
    createdProjectId = created.id;
    expect(created.studioId).toBe(anchor.studioId);
    await page.waitForURL(`**/project/${slug}-${created.id}`);
    const tabName = page.locator('[data-testid^="space-tab-name-"]');
    await expect(tabName).toHaveCount(1);
    const tabTestId = await tabName.getAttribute('data-testid');
    if (tabTestId === null) throw new Error('the initial Timeline tab has no identity');
    const spaceId = tabTestId.replace('space-tab-name-', '');
    expect(spaceId).toMatch(/^[0-9a-f-]{36}$/);
    await expectEmptyTimeline(page, created.id, spaceId);
  } finally {
    if (createdProjectId !== null) {
      expect(await archiveProjects(page.request, [createdProjectId])).toEqual([]);
    }
  }
});

test('a Timeline created from New Space reopens the same initialized Space from the drawer after its tab closes', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  let spaceId: string | null = null;
  try {
    spaceId = await createSpace(page, 'timeline', `Smoke Timeline ${Date.now()}`);
    await expectEmptyTimeline(page, projectId, spaceId);

    await page.getByTestId(`space-tab-${spaceId}`).hover();
    await page.getByTestId(`space-tab-close-${spaceId}`).click();
    await expect(page.getByTestId(`space-tab-name-${spaceId}`)).toHaveCount(0);
    await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toHaveCount(0);

    await page.getByTestId('space-drawer-trigger').click();
    const drawer = page.getByTestId('space-drawer');
    await expect(drawer).toBeVisible();
    await drawer.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button', { name: /Open/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId(`space-tab-name-${spaceId}`)).toBeVisible();
    await expectEmptyTimeline(page, projectId, spaceId, false);
  } finally {
    if (spaceId !== null) await deleteSpace(page, spaceId);
  }
});
