// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { smokeProjectId, openSmokeProject } from '../helpers/project';
import { dataOf } from '../helpers/api';
import type { ProjectVisitRequest } from '@breatic/shared';
import { inspectVisitDb, nextVisit, readVisit, saveVisitEvidence, watchVisits, type RecordedVisitLookup } from '../helpers/project-visits';

interface PageShow { persisted: boolean; path: string; absoluteAt: string; navigationType: string | null; documentId: string }
interface CacheTelemetry { pageshows: PageShow[]; navigationType: string | null; notRestoredReasonsSupported: boolean; notRestoredReasons: unknown }

/** Read browser-generated restoration facts, retaining each actual document identity. @throws {Error} When the live page is unavailable. */
async function cacheTelemetry(page: Page, key: string): Promise<CacheTelemetry> {
  return page.evaluate((key) => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & { notRestoredReasons?: unknown };
    return {
      pageshows: JSON.parse(sessionStorage.getItem(key) ?? '[]') as PageShow[],
      navigationType: navigation?.type ?? null,
      notRestoredReasonsSupported: !!navigation && 'notRestoredReasons' in navigation,
      notRestoredReasons: navigation?.notRestoredReasons ?? null,
    };
  }, key);
}

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
      const documentId = crypto.randomUUID();
      window.addEventListener('pageshow', (event) => {
        const previous = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown[];
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        previous.push({ persisted: event.persisted, path: location.pathname, absoluteAt: new Date().toISOString(), navigationType: navigation?.type ?? null, documentId });
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
    const returnedId = ((await returnedRequest).postDataJSON() as ProjectVisitRequest).visit_id;
    const returned = await dataOf<RecordedVisitLookup>(await page.request.get(`/api/v1/projects/${projectId}/opened/${returnedId}`), 'real Chrome Back original receipt');
    expect(returned.status).toBe('recorded'); expect(returned.visit_id).toBe(returnedId);
    await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
    expect(returned.visit_id).not.toBe(first.visit_id);
    // Vite may reload its document after the restored dev websocket is lost.
    // Require one new visit for EACH actual pageshow, including that separate
    // cold document; never relax the assertion to "at least two" visits.
    await expect(async () => {
      const actual = await cacheTelemetry(page, storageKey);
      const projectShows = actual.pageshows.filter((event) => event.path.includes(projectId));
      expect(projectShows[0]?.persisted).toBe(false);
      expect(projectShows.length).toBeGreaterThan(1);
      expect(traffic.posts).toHaveLength(projectShows.length);
      expect(new Set(traffic.posts.map((post) => post.visitId)).size).toBe(projectShows.length);
      const receipts: RecordedVisitLookup[] = [];
      for (const post of traffic.posts) {
        const receipt = await dataOf<RecordedVisitLookup>(await page.request.get(`/api/v1/projects/${projectId}/opened/${post.visitId}`), 'actual activation original receipt');
        expect(receipt).toMatchObject({ status: 'recorded', account_id: first.account_id, project_id: projectId, visit_id: post.visitId });
        receipts.push(receipt);
      }
      expect(receipts[0]).toMatchObject(first);
      expect(receipts.find((receipt) => receipt.visit_id === returned.visit_id)).toEqual(returned);
      for (const activation of projectShows.filter((event) => event.persisted)) expect(activation.documentId).toBe(projectShows[0]?.documentId);
      const persisted = await inspectVisitDb(returned);
      expect(persisted.events.filter((event) => event.kind === 'project_access')).toHaveLength(projectShows.length);
      for (const receipt of receipts) expect(persisted.events.filter((event) => event.visit_id === receipt.visit_id)).toEqual([{ kind: 'project_access', visit_id: receipt.visit_id, occurred_at: receipt.occurred_at }]);
      expect((await cacheTelemetry(page, storageKey)).pageshows).toEqual(actual.pageshows);
      await saveVisitEvidence('actual-chrome-back-cache-evidence', {
        ...actual, first, returned, persisted, posts: traffic.posts,
        activations: projectShows.map((activation, index) => ({ activation, post: traffic.posts[index], receipt: receipts[index] })),
        ignoredDefaultArgs: ['--disable-back-forward-cache'], syntheticPageshow: false,
      });
      test.info().annotations.push({ type: projectShows.some((event) => event.persisted) ? 'actual-bfcache-hit' : 'actual-bfcache-miss', description: JSON.stringify(actual.notRestoredReasons) });
    }).toPass({ timeout: 10_000, intervals: [250, 500] });
  } finally {
    traffic.stop();
    if (!page.isClosed()) await page.evaluate((key) => sessionStorage.removeItem(key), storageKey).catch(() => {});
    await context.close(); await browser.close();
  }
});
