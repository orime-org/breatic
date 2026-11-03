// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect } from 'playwright/test';
import type { ProjectVisitLookup } from '@breatic/shared';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { inspectVisitDb, readVisit, reconnectProject, saveVisitEvidence, watchVisits, type RecordedVisitLookup, type VisitReceipt } from '../helpers/project-visits';

for (const recovery of ['archive-reauth', 'transport-reconnect'] as const) {
  test(`a lost POST answer and unavailable first lookup recover the original visit through actual ${recovery}`, async ({ page }) => {
    const projectId = smokeProjectId();
    const traffic = watchVisits(page);
    const postPath = `**/api/v1/projects/${projectId}/opened`;
    const lookupPath = `**/api/v1/projects/${projectId}/opened/*`;
    let committed: VisitReceipt | undefined;
    let recoveryAllowed = false;
    let archived = false;
    const suppressedLookups: ProjectVisitLookup[] = [];
    await page.route(postPath, async (route) => {
      if (route.request().method() !== 'POST' || committed) { await route.continue(); return; }
      // The actual server commits first. Only its response to this browser is lost.
      committed = await readVisit(await route.fetch(), projectId);
      await route.abort('failed');
    });
    await page.route(lookupPath, async (route) => {
      if (route.request().method() !== 'GET' || recoveryAllowed) { await route.continue(); return; }
      // The server executes every lookup. Its browser-bound response remains
      // unavailable until the test restores this finite network fault.
      const actual = await route.fetch();
      suppressedLookups.push(await dataOf<ProjectVisitLookup>(actual, 'real original lookup before network restoration'));
      await route.abort('failed');
    });
    try {
      const failedLookup = page.waitForEvent('requestfailed', {
        predicate: (request) => request.method() === 'GET' && new URL(request.url()).pathname.startsWith(`/api/v1/projects/${projectId}/opened/`),
      });
      await openSmokeProject(page);
      await failedLookup;
      await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
      expect(suppressedLookups.length).toBeGreaterThan(0);
      expect(committed?.project_id).toBe(projectId);
      expect(traffic.posts).toHaveLength(1);
      const original = committed!;
      expect(traffic.posts[0]?.visitId).toBe(original.visit_id);
      const restoredAnswer = page.waitForResponse((response) => response.request().method() === 'GET'
        && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/opened/${original.visit_id}`);
      recoveryAllowed = true;
      if (recovery === 'archive-reauth') {
        await dataOf(await page.request.post(`/api/v1/projects/${projectId}/archive`), 'actual archive triggers provider reauthentication');
        archived = true;
        await expect(page.getByTestId('archived-banner')).toBeVisible();
      } else await reconnectProject(page, projectId);
      // This response belongs to the browser app, not a test's manual GET or
      // direct invocation of its private visit handle.
      const recovered = await dataOf<RecordedVisitLookup>(await restoredAnswer, 'application passive original-result lookup');
      expect(recovered).toEqual({ status: 'recorded', ...original });
      expect(traffic.posts).toHaveLength(1);
      const persisted = await inspectVisitDb(original);
      expect(persisted.events.filter((event) => event.kind === 'project_access')).toEqual([
        { kind: 'project_access', visit_id: original.visit_id, occurred_at: original.occurred_at },
      ]);
      if (archived) {
        await dataOf(await page.request.post(`/api/v1/projects/${projectId}/restore`), 'restore the Project after actual reauth');
        archived = false;
        await expect(page.getByTestId('archived-banner')).toHaveCount(0);
      }
      await expect(page.getByTestId('space-drawer-trigger')).toBeVisible();
      await page.getByTestId('top-bar-back').click();
      await expect(page.locator(`a[href$="-${projectId}"]`)).toHaveCount(1);
      expect(traffic.posts).toHaveLength(1);
      await saveVisitEvidence(`passive-${recovery}-original-receipt`, {
        recovery, original, recovered, suppressedLookups, posts: traffic.posts, persisted,
        fault: 'real POST and initial GET execute, browser-bound replies aborted until explicit recovery',
        directHandleRefresh: false, manualReceiptGet: false, crossDayFixture: false,
      });
    } finally {
      await page.unroute(postPath); await page.unroute(lookupPath);
      if (archived) await dataOf(await page.request.post(`/api/v1/projects/${projectId}/restore`), 'restore for cleanup');
      traffic.stop();
    }
  });
}
