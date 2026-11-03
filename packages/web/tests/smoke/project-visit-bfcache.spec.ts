// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { smokeProjectId, openSmokeProject } from '../helpers/project';
import { dataOf } from '../helpers/api';
import { inspectVisitDb, nextVisit, readVisit, watchVisits, type VisitReceipt } from '../helpers/project-visits';

test('a real Chrome cross-document Back records whether bfcache restored and starts a fresh Project visit', async ({ playwright, baseURL }) => {
  // Playwright 1.62.1 coreBundle.js includes this default switch. Remove only
  // that switch for this finite probe; do not fake pageshow or alter the app.
  const browser = await playwright.chromium.launch({ channel: 'chrome', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  const context = await browser.newContext({ baseURL, storageState: stateFile('A') });
  const page = await context.newPage();
  const storageKey = `visit-pageshow-${crypto.randomUUID()}`;
  const projectId = smokeProjectId();
  const traffic = watchVisits(page);
  try {
    await context.addInitScript((key) => {
      window.addEventListener('pageshow', (event) => {
        const previous = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown[];
        previous.push({ persisted: event.persisted, path: location.pathname, time: performance.now() });
        sessionStorage.setItem(key, JSON.stringify(previous));
      });
    }, storageKey);
    const firstAnswer = nextVisit(page, projectId);
    await openSmokeProject(page);
    const first = await readVisit(await firstAnswer, projectId);
    await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
    await page.goto('/studio');
    await expect(page).toHaveURL(/\/studio$/);
    const returnedAnswer = nextVisit(page, projectId);
    const returnedRequest = page.waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/projects/${projectId}/opened`);
    await page.goBack();
    expect((await returnedAnswer).ok()).toBe(true);
    // Chrome can evict CDP response bodies while switching restored documents.
    // The actual request identity plus actual GET reads the same committed fact.
    const returnedId = ((await returnedRequest).postDataJSON() as { visit_id: string }).visit_id;
    const returned = await dataOf<VisitReceipt & { status: 'recorded' }>(await page.request.get(`/api/v1/projects/${projectId}/opened/${returnedId}`), 'real Chrome Back original receipt');
    expect(returned.status).toBe('recorded'); expect(returned.visit_id).toBe(returnedId);
    await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
    expect(returned.visit_id).not.toBe(first.visit_id);
    const actual = await page.evaluate((key) => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & { notRestoredReasons?: unknown };
      return {
        pageshows: JSON.parse(sessionStorage.getItem(key) ?? '[]') as Array<{ persisted: boolean; path: string; time: number }>,
        navigationType: navigation?.type,
        notRestoredReasonsSupported: !!navigation && 'notRestoredReasons' in navigation,
        notRestoredReasons: navigation?.notRestoredReasons ?? null,
      };
    }, storageKey);
    const projectShows = actual.pageshows.filter((event) => event.path.includes(projectId));
    expect(projectShows).toHaveLength(2);
    expect(traffic.posts).toHaveLength(2);
    const persisted = await inspectVisitDb(returned);
    for (const receipt of [first, returned]) expect(persisted.events.filter((event) => event.visit_id === receipt.visit_id)).toEqual([{ kind: 'project_access', visit_id: receipt.visit_id, occurred_at: receipt.occurred_at }]);
    test.info().annotations.push({ type: projectShows[1]?.persisted ? 'actual-bfcache-hit' : 'actual-bfcache-miss', description: JSON.stringify(actual.notRestoredReasons) });
    await test.info().attach('actual-chrome-back-cache-evidence', {
      body: JSON.stringify({ ...actual, first, returned, persisted, posts: traffic.posts, ignoredDefaultArgs: ['--disable-back-forward-cache'], syntheticPageshow: false }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    traffic.stop();
    if (!page.isClosed()) await page.evaluate((key) => sessionStorage.removeItem(key), storageKey).catch(() => {});
    await context.close(); await browser.close();
  }
});
