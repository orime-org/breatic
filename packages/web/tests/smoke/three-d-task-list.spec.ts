// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The 3D Space's task list around generation rows (inner#1691 design 7.3):
 * its empty text, its filter menu, and which row actions an editor and a
 * viewer get.
 *
 * Generation rows cost a real model run, so the rows here are served in the
 * list's answer; everything they are drawn by and acted on is the real page.
 * A real run's row is covered by three-d-generation.spec.ts.
 *
 * Another member's model upload is real (inner#2061): the list, the tab
 * spinner and the Tasks count follow the Space document's task version, so
 * they move with no task panel open and catch up after a lost connection.
 */

import { expect, type Locator, type Page, type Route } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { roomForUploads } from '../helpers/upload-budget';
import { setTimelineConnection } from '../helpers/timeline-media';

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
function generationRow(id: string, status: 'failed' | 'done' | 'running', startedBy: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  return {
    id, label: `Chest ${id.slice(0, 4)}`, status, startedByUserId: startedBy,
    startedAt: new Date(now - 60_000).toISOString(), deadlineAt: new Date(now + 3_600_000).toISOString(),
    assetId: status === 'done' ? crypto.randomUUID() : null, kind: 'generation',
    errorCode: status === 'failed' ? 'internal' : null, origin: 'space',
    model: { name: 'tripo-h3.1-t23d', displayName: 'Tripo H3.1' }, mode: 't23d',
    prompt: 'A small wooden treasure chest', negativePrompt: null, params: { texture: false, pbr: false }, inputs: [],
    ...extra,
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
  // Picking a radio item closes the menu with an exit animation, and a click on the trigger before
  // that animation ends is lost (#1421): each pick waits for the menu to go. An Escape once it has
  // gone would close the tasks panel.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.getByTestId('scene-task-filter').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Generate', exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(panel.locator('[data-testid^="scene-task-"]')).toHaveCount(3);

  await row(rows.failedOwn).getByRole('button', { name: 'Retry', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI generation', exact: true });
  await expect(dialog).toContainText('Filled in from the earlier task. Check it, then generate.');
  await expect(dialog.getByLabel('Prompt', { exact: true })).toHaveValue('A small wooden treasure chest');
  await expect(dialog.getByRole('switch', { name: 'Texture', exact: true })).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('generation rows asked to rig say how the skeleton went (inner#1692)', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-tasks-rig-${crypto.randomUUID()}`);
  created.push(id);
  const me = await whoIs(page);
  const rows = { failed: crypto.randomUUID(), rigged: crypto.randomUUID(), running: crypto.randomUUID() };
  const rig = { texture: false, pbr: false, rig_skeleton: true };
  await page.route((url) => url.pathname.endsWith(`/three-d/${id}/tasks`), async (route: Route) => {
    const response = await route.fetch();
    const body = await response.json() as { data: { tasks: unknown[] } };
    body.data.tasks = [
      generationRow(rows.failed, 'done', me, { params: rig, notice: 'rig_failed' }),
      generationRow(rows.rigged, 'done', me, { params: rig, notice: null }),
      generationRow(rows.running, 'running', me, { params: rig, notice: null }),
    ];
    await route.fulfill({ response, json: body });
  });
  const panel = await openTasks(page);
  await expect(panel.getByTestId(`scene-task-${rows.failed}`)).toContainText('Skeleton rigging failed;');
  await expect(panel.getByTestId(`scene-task-${rows.rigged}`)).toContainText('Skeleton rigged');
  await expect(panel.getByTestId(`scene-task-${rows.running}`)).toContainText('A skeleton is rigged when generation finishes');
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

/**
 * Open a real 3D model upload in a Space, as the given member, without sending its bytes.
 * @param member - A page signed in as an editor of the smoke Project.
 * @param spaceId - The 3D Space.
 * @returns The Space row the upload opened.
 */
async function openSceneUpload(member: Page, spaceId: string): Promise<string> {
  await roomForUploads(1, 'B');
  const ticket = await dataOf<{ taskId: string }>(await member.request.post('/api/v1/assets/upload-ticket', {
    data: {
      project_id: smokeProjectId(), purpose: 'scene_model', space_id: spaceId, label: 'Barn lamp', filename: 'lamp.glb',
      content_type: 'model/gltf-binary', size: 4096, client_hash: [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    },
  }), 'open a 3D model upload');
  return ticket.taskId;
}

/**
 * End an upload the member opened, as its browser does when the bytes never arrive.
 * @param member - The uploader.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 */
async function abandonSceneUpload(member: Page, spaceId: string, taskId: string): Promise<void> {
  await dataOf(await member.request.post(`/api/v1/projects/${smokeProjectId()}/three-d/${spaceId}/tasks/${taskId}/failure`, {
    data: { reason: 'aborted' },
  }), 'report the upload failed');
}

test.describe('another member\'s 3D upload (inner#2061) @needs-ingest @needs-storage', () => {
  test('lights the 3D tab and the Tasks count with no panel open, and its end clears both', async ({ page, browser, baseURL }) => {
    const otherContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
    const projectId = smokeProjectId();
    let otherId: string | undefined;
    try {
      await openSmokeProject(page);
      const id = await createSpace(page, '3d', `scene-tasks-peer-${crypto.randomUUID()}`);
      created.push(id);
      await expect(visibleSpace(page).getByTestId('three-d-viewport')).toBeVisible();
      const other = await inviteMember(page, otherContext, projectId, credentialsFor('B').email, 'editor');
      otherId = await whoIs(other);
      const busy = page.getByTestId(`space-tab-busy-${id}`);
      const count = visibleSpace(page).getByTestId('scene-tasks-count');
      await expect(busy).toHaveCount(0);
      await expect(count).toHaveCount(0);

      const taskId = await openSceneUpload(other, id);
      await expect(busy).toBeVisible();
      await expect(count).toHaveText('1');
      await expect(visibleSpace(page).getByTestId('scene-tasks-panel')).toHaveCount(0);

      await abandonSceneUpload(other, id, taskId);
      await expect(busy).toHaveCount(0);
      await expect(count).toHaveCount(0);
    } finally {
      try {
        await otherContext.close();
      } finally {
        if (otherId) await cleanMembership(page, projectId, otherId);
      }
    }
  });

  test('shows the server\'s rows after a lost connection comes back', async ({ page, browser, baseURL }) => {
    const otherContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
    const projectId = smokeProjectId();
    let otherId: string | undefined;
    try {
      await openSmokeProject(page);
      const id = await createSpace(page, '3d', `scene-tasks-reconnect-${crypto.randomUUID()}`);
      created.push(id);
      await expect(visibleSpace(page).getByTestId('three-d-viewport')).toBeVisible();
      const other = await inviteMember(page, otherContext, projectId, credentialsFor('B').email, 'editor');
      otherId = await whoIs(other);
      const panel = await openTasks(page);
      await expect(panel).toHaveText('Models you import or generate appear here.');

      // Offline keeps the socket from coming back; closing it drops the connection the page already holds.
      await page.context().setOffline(true);
      await setTimelineConnection(page, projectId, id, false);
      const taskId = await openSceneUpload(other, id);
      // Disconnected, this page cannot have heard of the row.
      await expect(panel.getByTestId(`scene-task-${taskId}`)).toHaveCount(0);
      await page.context().setOffline(false);
      await setTimelineConnection(page, projectId, id, true);

      await expect(panel.getByTestId(`scene-task-${taskId}`)).toBeVisible({ timeout: 30_000 });
      await expect(visibleSpace(page).getByTestId('scene-tasks-count')).toHaveText('1');
      await abandonSceneUpload(other, id, taskId);
      await expect(visibleSpace(page).getByTestId('scene-tasks-count')).toHaveCount(0);
    } finally {
      await page.context().setOffline(false);
      try {
        await otherContext.close();
      } finally {
        if (otherId) await cleanMembership(page, projectId, otherId);
      }
    }
  });
});
