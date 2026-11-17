// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A person's own monthly spend limit (inner#1968, test spec K-04): the
 * Studio's admin sets member B's limit to 0 on the Studio's Credits tab, and
 * B pressing Generate is refused with the per-person sentence, which names the
 * reset day in B's own time.
 *
 * A makes a team Studio of its own with B in it; the limit is judged before
 * anything is held or run, so no model is called. B's browser runs in Los
 * Angeles, where the next UTC month's first instant is still the last day of
 * this month, so a date read in UTC would show the wrong day.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { setLocale, setLocaleMessages, t } from '@breatic/shared';
import { expect, type BrowserContext } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { openCanvas, pressGenerate } from '../helpers/metered-account';
import { seedNode } from '../helpers/mini-tool';
import { MADE_BY_SMOKE } from '../helpers/project';
import { stateFile, test } from '../helpers/slot';
import { visibleSpace } from '../helpers/space';

/** The English catalog the suite's accounts read the product in. */
const EN = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/en.json'), 'utf8')) as Record<string, unknown>;
// The expected sentence is formatted the way the page formats it: the message is ICU, with a plural select.
setLocaleMessages('en', EN);
setLocale('en');

/** B's time zone: behind UTC, so the UTC month's first instant is the day before there. */
const B_TIME_ZONE = 'America/Los_Angeles';

test('a member whose own limit is 0 is refused Generate with the reset day in local time @needs-payments', async ({ browser, page }) => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const slug = `spend-cap-${stamp}`;
  const a = page.context().request;
  let b: BrowserContext | undefined;
  let projectId: string | undefined;
  try {
    // A team Studio run by A, with B in it, and a project there.
    await dataOf(await a.post('/api/v1/studios', { data: { name: `Spend cap ${stamp}`, slug } }), 'create the team studio');
    const studio = await dataOf<{ id: string }>(await a.get(`/api/v1/studio/${slug}`), 'read the team studio');
    await dataOf(
      await a.post(`/api/v1/studio/${slug}/members`, { data: { email: credentialsFor('B').email, role: 'maintainer' } }),
      'invite B to the studio',
    );
    b = await browser.newContext({ storageState: stateFile('B'), timezoneId: B_TIME_ZONE, viewport: { width: 1600, height: 1000 } });
    const bell = await dataOf<{ items: { type: string; payload: { shareToken?: string; studioId?: string } }[] }>(
      await b.request.get('/api/v1/users/me/notifications'),
      'read B bell',
    );
    const token = bell.items.find((n) => n.type === 'studio.invite_request' && n.payload.studioId === studio.id)?.payload.shareToken;
    expect(token, 'B got no studio invite').toBeDefined();
    await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'B joins the studio');
    // Who B is to the Studio's member table: the name of B's personal studio.
    const bName = (await dataOf<{ personalStudio: { name: string } }>(await b.request.get('/api/v1/auth/me'), 'read B')).personalStudio.name;
    const project = await dataOf<{ id: string }>(
      await a.post('/api/v1/projects', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: { studioId: studio.id, name: `Spend cap ${stamp}`, slug: `${MADE_BY_SMOKE}-spend-cap-${stamp}`, spaceType: 'canvas' },
      }),
      'create the project',
    );
    projectId = project.id;
    // A Studio member still joins each project on its own invite.
    await dataOf(
      await a.post(`/api/v1/projects/${projectId}/invitations`, { data: { email: credentialsFor('B').email, role: 'editor' } }),
      'invite B to the project',
    );
    const projectBell = await dataOf<{ items: { type: string; payload: { shareToken?: string; projectId?: string } }[] }>(
      await b.request.get('/api/v1/users/me/notifications'),
      'read B bell again',
    );
    const projectToken = projectBell.items.find((n) => n.type === 'project.invite_request' && n.payload.projectId === projectId)?.payload.shareToken;
    expect(projectToken, 'B got no project invite').toBeDefined();
    await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token: projectToken, action: 'confirm' } }), 'B joins the project');

    // The admin sets B's own limit to 0 on the Studio's Credits tab.
    await page.goto(`/studio/${slug}/credits`);
    const caps = page.getByTestId('studio-spend-caps');
    const row = caps.locator('tr').filter({ hasText: bName });
    await expect(row).toHaveCount(1, { timeout: 20_000 });
    await row.getByRole('button', { name: 'Set own limit…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('0 (no credits)').click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toContainText('0 (no credits)');

    // B presses Generate and is refused.
    const bPage = await b.newPage();
    const spaceId = await openCanvas(bPage, projectId);
    const nodeId = randomUUID();
    await seedNode(bPage, { projectId, spaceId }, nodeId, 'image', 0, { name: 'capped', state: 'idle' });
    await bPage.getByTestId('viewport-toolbar').getByRole('button', { name: 'Hide minimap', exact: true }).click();
    await pressGenerate(bPage, nodeId);

    const now = new Date();
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const localDay = resetsAt.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric', timeZone: B_TIME_ZONE });
    const utcDay = resetsAt.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    expect(localDay).not.toBe(utcDay);
    const sentence = t('credits.spendCap.member', { limit: '0', date: localDay });
    const toast = bPage.locator('[data-sonner-toast]').filter({ hasText: sentence });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).not.toContainText(utcDay);
    await expect(visibleSpace(bPage).locator(`.react-flow__node[data-id="${nodeId}"]`).getByTestId('task-count-running')).toHaveCount(0);
  } finally {
    if (projectId !== undefined) {
      // Archiving closes the project's documents, its one Space included.
      const archived = await a.post(`/api/v1/projects/${projectId}/archive`);
      expect(archived.ok(), `archive the case's project: ${archived.status()}`).toBe(true);
    }
    await b?.close();
  }
});
