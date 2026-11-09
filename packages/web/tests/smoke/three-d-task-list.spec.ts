// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D Space's task list around generation rows (inner#1691 design 7.3):
 * its empty text, its filter menu, and which row actions an editor and a
 * viewer get.
 *
 * Generation rows cost a real model run, so the rows here are served in the
 * list's answer; everything they are drawn by and acted on is the real page.
 * A real run's row is covered by three-d-generation.spec.ts.
 */

import { expect, type Locator, type Page, type Route } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  for (const id of created.splice(0)) await deleteSpace(page, id);
});

/** The rows the list is answered with. */
interface ServedRows {
  failedOwn: string;
  failedOther: string;
  done: string;
}

/**
 * One generation row as the list answers it.
 * @param id - The row.
 * @param status - Its state.
 * @param startedBy - Who started it.
 * @returns The row.
 */
function generationRow(id: string, status: 'failed' | 'done', startedBy: string): Record<string, unknown> {
  const now = Date.now();
  return {
    id, label: `Chest ${id.slice(0, 4)}`, status, startedByUserId: startedBy,
    startedAt: new Date(now - 60_000).toISOString(), deadlineAt: new Date(now + 3_600_000).toISOString(),
    assetId: status === 'done' ? crypto.randomUUID() : null, kind: 'generation',
    errorCode: status === 'failed' ? 'internal' : null, origin: 'space',
    model: { name: 'tripo-h3.1-t23d', displayName: 'Tripo H3.1' }, mode: 't23d',
    prompt: 'A small wooden treasure chest', negativePrompt: null, params: { texture: false, pbr: false }, inputs: [],
  };
}

/**
 * Answer the Space's task list with three generation rows, on the server's own envelope and clock.
 * @param page - The page reading the list.
 * @param spaceId - The 3D Space.
 * @param owner - The editor's account.
 * @param other - The other account.
 * @returns The served rows' ids.
 */
async function serveRows(page: Page, spaceId: string, owner: string, other: string): Promise<ServedRows> {
  const rows: ServedRows = { failedOwn: crypto.randomUUID(), failedOther: crypto.randomUUID(), done: crypto.randomUUID() };
  await page.route((url) => url.pathname.endsWith(`/three-d/${spaceId}/tasks`), async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json() as { data: { tasks: unknown[] } };
    body.data.tasks = [generationRow(rows.failedOwn, 'failed', owner), generationRow(rows.failedOther, 'failed', other), generationRow(rows.done, 'done', owner)];
    await route.fulfill({ response, json: body });
  });
  return rows;
}

/**
 * Open the visible Space's task list.
 * @param page - The page.
 * @returns The panel.
 */
async function openTasks(page: Page): Promise<Locator> {
  await visibleSpace(page).getByTestId('scene-tasks-trigger').click();
  const panel = visibleSpace(page).getByTestId('scene-tasks-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * The account a context is signed in as.
 * @param page - A page of that context.
 * @returns Its user id.
 */
async function whoIs(page: Page): Promise<string> {
  return (await dataOf<{ id: string }>(await page.request.get('/api/v1/auth/me'), 'read account identity')).id;
}

test('an empty 3D Space task list says imported and generated models appear there', async ({ page }) => {
  await openSmokeProject(page);
  created.push(await createSpace(page, '3d', `scene-tasks-empty-${crypto.randomUUID()}`));
  await expect(await openTasks(page)).toHaveText('Models you import or generate appear here.');
});

test('an editor filters generation rows and gets Retry, Remove and Place on them', async ({ page, browser, baseURL }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-tasks-editor-${crypto.randomUUID()}`);
  created.push(id);
  const other = await browser.newContext({ baseURL, storageState: stateFile('B') });
  const otherId = (await dataOf<{ id: string }>(await other.request.get('/api/v1/auth/me'), 'read the other account')).id;
  await other.close();
  const rows = await serveRows(page, id, await whoIs(page), otherId);
  const panel = await openTasks(page);
  const row = (rowId: string): Locator => panel.getByTestId(`scene-task-${rowId}`);
  await expect(row(rows.failedOwn).getByRole('button')).toHaveText(['Retry', 'Remove']);
  await expect(row(rows.failedOther).getByRole('button')).toHaveText(['Remove']);
  await expect(row(rows.done).getByRole('button')).toHaveText(['Place in scene']);
  await expect(row(rows.done)).toContainText('Tripo H3.1 · You · In Space');

  await page.getByTestId('scene-task-filter').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Running only', exact: true })).toBeVisible();
  for (const group of ['Type', 'Started by', 'Origin']) await expect(menu.getByText(group, { exact: true })).toBeVisible();
  await menu.getByRole('menuitemradio', { name: 'Import', exact: true }).click();
  await expect(panel).toContainText('No tasks match the filters.');
  await expect(page.getByTestId('scene-task-filter-count')).toHaveText('1');
  await page.keyboard.press('Escape');
  await page.getByTestId('scene-task-filter').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Generate', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(panel.locator('[data-testid^="scene-task-"]')).toHaveCount(3);

  await row(rows.failedOwn).getByRole('button', { name: 'Retry', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI generation', exact: true });
  await expect(dialog).toContainText('Filled in from the earlier task. Check it, then generate.');
  await expect(dialog.getByLabel('Prompt', { exact: true })).toHaveValue('A small wooden treasure chest');
  await expect(dialog.getByRole('switch', { name: 'Texture', exact: true })).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('a viewer reads generation rows with no Retry, Remove or Place', async ({ page, browser, baseURL }) => {
  const viewerContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
  const projectId = smokeProjectId();
  let viewerId: string | undefined;
  try {
    await openSmokeProject(page);
    const id = await createSpace(page, '3d', `scene-tasks-viewer-${crypto.randomUUID()}`);
    created.push(id);
    const viewer = await inviteMember(page, viewerContext, projectId, credentialsFor('B').email, 'viewer');
    viewerId = await whoIs(viewer);
    // The viewer's own failed row too: only the role keeps Retry and Remove off it.
    const rows = await serveRows(viewer, id, await whoIs(page), viewerId);
    await viewer.goto(smokeProjectUrl());
    await viewer.getByTestId('space-drawer-trigger').click();
    await viewer.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(visibleSpace(viewer).getByTestId('three-d-viewport')).toBeVisible();
    const panel = await openTasks(viewer);
    for (const rowId of [rows.failedOwn, rows.failedOther, rows.done]) {
      await expect(panel.getByTestId(`scene-task-${rowId}`)).toBeVisible();
      await expect(panel.getByTestId(`scene-task-${rowId}`).getByRole('button')).toHaveCount(0);
    }
  } finally {
    try {
      await viewerContext.close();
    } finally {
      if (viewerId) await cleanMembership(page, projectId, viewerId);
    }
  }
});
