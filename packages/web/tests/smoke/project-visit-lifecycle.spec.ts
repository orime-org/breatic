// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR } from '../helpers/space';
import { selectInBody } from '../helpers/editor-keys';
import { liveModuleUrl } from '../helpers/live-module';
import { inspectVisitDb, nextVisit, readVisit, reconnectProject, watchVisits, type VisitReceipt } from '../helpers/project-visits';

test('real Project entry, keyboard SPA return and browser Back create distinct visits', async ({ page }) => {
  const projectId = smokeProjectId();
  const traffic = watchVisits(page);
  const firstAnswer = nextVisit(page, projectId);
  await openSmokeProject(page);
  const first = await readVisit(await firstAnswer, projectId);
  await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
  const back = page.getByTestId('top-bar-back');
  await back.focus(); await expect(back).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/studio$/);
  const recent = page.locator(`a[href$="-${projectId}"]`);
  await expect(recent).toHaveCount(1);
  const secondAnswer = nextVisit(page, projectId);
  await recent.focus(); await page.keyboard.press('Enter');
  const second = await readVisit(await secondAnswer, projectId);
  expect(second.visit_id).not.toBe(first.visit_id);
  await page.getByTestId('top-bar-back').click();
  await expect(page).toHaveURL(/\/studio$/);
  const thirdAnswer = nextVisit(page, projectId);
  await page.goBack();
  const third = await readVisit(await thirdAnswer, projectId);
  expect(new Set([first.visit_id, second.visit_id, third.visit_id]).size).toBe(3);
  expect(traffic.posts).toHaveLength(3);
  const persisted = await inspectVisitDb(third);
  for (const receipt of [first, second, third]) expect(persisted.events.filter((event) => event.visit_id === receipt.visit_id)).toEqual([{ kind: 'project_access', visit_id: receipt.visit_id, occurred_at: receipt.occurred_at }]);
  await test.info().attach('actual-navigation-receipts', { body: JSON.stringify({ first, second, third, posts: traffic.posts, persisted }, null, 2), contentType: 'application/json' });
  traffic.stop();
});

test('passive account refresh, archive reauth and transport reconnect preserve the original entry and editable content', async ({ page }) => {
  const projectId = smokeProjectId();
  const traffic = watchVisits(page);
  const answer = nextVisit(page, projectId);
  await openSmokeProject(page);
  const original = await readVisit(await answer, projectId);
  let spaceId: string | undefined;
  let archived = false;
  try {
    spaceId = await createSpace(page, 'document', `visit-content-${crypto.randomUUID()}`);
    const editor = page.locator(DOCUMENT_EDITOR);
    await expect(editor).toBeVisible();
    const marker = `visit-${crypto.randomUUID()}`;
    await selectInBody(page, () => editor.evaluate((element) => {
      const paragraphs = element.querySelectorAll('p');
      const paragraph = paragraphs.item(paragraphs.length - 1);
      if (!paragraph) throw new Error('The actual document paragraph is missing');
      const range = document.createRange(); range.selectNodeContents(paragraph); range.collapse(false);
      const selection = window.getSelection(); if (!selection) throw new Error('No editor selection');
      selection.removeAllRanges(); selection.addRange(range);
    }));
    await page.keyboard.type(marker);
    await expect(editor).toContainText(marker);
    const userUrl = await liveModuleUrl(page, 'stores/current-user.ts');
    const refreshedAccount = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/me' && response.request().method() === 'GET');
    await page.evaluate(async (url) => {
      const current = await import(/* @vite-ignore */ url) as { refreshCurrentUser: () => Promise<void>; useCurrentUserStore: { getState: () => { user: { id: string } | null } } };
      if (!current.useCurrentUserStore.getState().user) throw new Error('The live auth singleton is empty');
      await current.refreshCurrentUser();
    }, userUrl);
    expect((await refreshedAccount).ok()).toBe(true);
    const archiveRefresh = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}`);
    await dataOf(await page.request.post(`/api/v1/projects/${projectId}/archive`), 'external archive HTTP action'); archived = true;
    await archiveRefresh; await expect(page.getByTestId('archived-banner')).toBeVisible();
    const restoreRefresh = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}`);
    await dataOf(await page.request.post(`/api/v1/projects/${projectId}/restore`), 'external restore HTTP action'); archived = false;
    await restoreRefresh; await expect(page.getByTestId('archived-banner')).toHaveCount(0);
    await reconnectProject(page, projectId);
    await expect(editor).toHaveAttribute('contenteditable', 'true'); await expect(editor).toContainText(marker);
    const queried = await dataOf<VisitReceipt & { status: 'recorded' }>(await page.request.get(`/api/v1/projects/${projectId}/opened/${original.visit_id}`), 'original receipt after passive activity');
    expect(queried).toEqual({ status: 'recorded', ...original });
    expect(traffic.posts).toHaveLength(1);
    const persisted = await inspectVisitDb(original);
    expect(persisted.events.some((event) => event.kind === 'project_edit')).toBe(true);
    expect(persisted.events.filter((event) => event.visit_id === original.visit_id)).toEqual([{ kind: 'project_access', visit_id: original.visit_id, occurred_at: original.occurred_at }]);
    for (const theme of ['dark', 'light']) {
      await page.getByTestId('theme-toggle').click(); await page.getByTestId(`theme-option-${theme}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(editor).toContainText(marker);
      await test.info().attach(`actual-project-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
    }
    expect(traffic.posts).toHaveLength(1);
    await test.info().attach('passive-entry-evidence', { body: JSON.stringify({ original, queried, persisted, posts: traffic.posts, crossDayFixture: false }, null, 2), contentType: 'application/json' });
  } finally {
    if (archived) await dataOf(await page.request.post(`/api/v1/projects/${projectId}/restore`), 'restore for cleanup');
    if (spaceId) await deleteSpace(page, spaceId);
    traffic.stop();
  }
});

test('a committed opened response lost in transit is queried by its original identity and keeps the recent listing', async ({ page }) => {
  const projectId = smokeProjectId();
  const traffic = watchVisits(page);
  const path = `**/api/v1/projects/${projectId}/opened`;
  let committed: VisitReceipt | undefined;
  await page.route(path, async (route) => {
    // This is fault injection after real server commit, not a mocked API result.
    if (route.request().method() !== 'POST' || committed) { await route.continue(); return; }
    const actual = await route.fetch();
    committed = await readVisit(actual, projectId);
    await route.abort('failed');
  });
  try {
    const recoveredAnswer = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname.startsWith(`/api/v1/projects/${projectId}/opened/`));
    await openSmokeProject(page);
    const recovered = await dataOf<VisitReceipt & { status: 'recorded' }>(await recoveredAnswer, 'real original-result recovery');
    expect(committed).toBeDefined();
    expect(recovered).toMatchObject({ ...committed, status: 'recorded' });
    await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
    expect(traffic.posts).toHaveLength(1);
    const before = await dataOf<Array<{ id: string; lastOpenedAt: string }>>(await page.request.get('/api/v1/studios/recent'), 'recent before original replay');
    const replay = await dataOf<VisitReceipt>(await page.request.post(`/api/v1/projects/${projectId}/opened`, { data: { visit_id: committed!.visit_id } }), 'actual original identity replay');
    expect(replay).toMatchObject(committed!);
    const after = await dataOf<typeof before>(await page.request.get('/api/v1/studios/recent'), 'recent after original replay');
    expect(after.map(({ id, lastOpenedAt }) => ({ id, lastOpenedAt }))).toEqual(before.map(({ id, lastOpenedAt }) => ({ id, lastOpenedAt })));
    await page.getByTestId('top-bar-back').click();
    await expect(page.locator(`a[href$="-${projectId}"]`)).toHaveCount(1);
    const next = nextVisit(page, projectId);
    await page.locator(`a[href$="-${projectId}"]`).click();
    const fresh = await readVisit(await next, projectId);
    expect(fresh.visit_id).not.toBe(committed!.visit_id);
    const persisted = await inspectVisitDb(fresh);
    for (const receipt of [committed!, fresh]) expect(persisted.events.filter((event) => event.visit_id === receipt.visit_id)).toEqual([{ kind: 'project_access', visit_id: receipt.visit_id, occurred_at: receipt.occurred_at }]);
    await test.info().attach('lost-response-original-evidence', { body: JSON.stringify({ committed, recovered, replay, fresh, before, after, persisted, posts: traffic.posts }, null, 2), contentType: 'application/json' });
  } finally { await page.unroute(path); traffic.stop(); }
});
