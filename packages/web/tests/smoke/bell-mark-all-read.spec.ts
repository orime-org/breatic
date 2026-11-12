// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The bell's "Mark all read", end to end.
 *
 * Account A ends up with one piece of news (B accepted A's studio invite) and
 * one request A still has to answer (B asked to join A's project). "Mark all
 * read" sits left of the count; clicking it clears the news, keeps the request
 * with its answer button, and the button goes away because nothing is left to
 * clear.
 *
 * The scene is built through the API — the part under test is what A does in
 * the browser.
 *
 *   pnpm --filter @breatic/web test:smoke -- bell-mark-all-read
 */
import { expect } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';

import { credentialsFor } from '../helpers/credentials';
import { dataOf } from '../helpers/api';

test('mark all read clears the news and keeps the request waiting on A', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext({ storageState: stateFile('B') });
  const emailB = credentialsFor('B').email;

  // Start from an inbox with nothing A could clear, so the counts below are this test's.
  await dataOf(await a.request.post('/api/v1/users/me/notifications/read-all'), 'A clears news');

  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const studioSlug = `bell-smoke-${stamp}`;
  await dataOf(
    await a.request.post('/api/v1/studios', { data: { name: `Bell smoke ${stamp}`, slug: studioSlug } }),
    'create studio',
  );
  const studio = await dataOf<{ id: string }>(await a.request.get(`/api/v1/studio/${studioSlug}`), 'studio');
  await dataOf(
    await a.request.post(`/api/v1/studio/${studioSlug}/members`, { data: { email: emailB, role: 'maintainer' } }),
    'invite B',
  );
  const bellB = await dataOf<{ items: { type: string; payload: { shareToken?: string; studioId?: string } }[] }>(
    await b.request.get('/api/v1/users/me/notifications'),
    'B bell',
  );
  const token = bellB.items.find(
    (n) => n.type === 'studio.invite_request' && n.payload.studioId === studio.id,
  )?.payload.shareToken;
  expect(token, 'B got no studio invite').toBeDefined();
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'B joins');

  const project = await dataOf<{ id: string }>(
    await a.request.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { studioId: studio.id, name: `Bell target ${stamp}`, slug: `bell-target-${stamp}`, spaceType: 'canvas' },
    }),
    'create project',
  );
  await dataOf(
    await b.request.post(`/api/v1/projects/${project.id}/join-requests`, { data: { message: 'let me in' } }),
    'B asks to join',
  );

  const page = await a.newPage();
  await page.goto(`/studio/${studioSlug}/projects`);
  await page.getByTestId('bell-trigger').click();
  const popover = page.getByTestId('bell-popover');
  const markAll = popover.getByTestId('bell-mark-all-read');
  await expect(markAll).toBeVisible({ timeout: 15_000 });
  await expect(markAll).toHaveText('Mark all read');
  const count = popover.getByTestId('bell-count');
  const [buttonBox, countBox] = [await markAll.boundingBox(), await count.boundingBox()];
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(countBox!.x);
  await expect(popover.locator('[data-testid^="bell-mark-read-"]')).toHaveCount(1);
  const decisions = popover.locator('[data-testid^="bell-open-decision-"]');
  const waiting = await decisions.count();
  expect(waiting).toBeGreaterThanOrEqual(1);

  await markAll.click();
  await expect(popover.locator('[data-testid^="bell-mark-read-"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(decisions).toHaveCount(waiting);
  await expect(markAll).toHaveCount(0);
  await expect(count).toHaveText(String(waiting));
  await expect(page.getByTestId('bell-unread-dot')).toBeVisible();

  // Answer the request this run filed, so A's inbox ends as it started.
  const bellA = await dataOf<{ items: { type: string; payload: { shareToken?: string; projectId?: string } }[] }>(
    await a.request.get('/api/v1/users/me/notifications'),
    'A bell',
  );
  const requestToken = bellA.items.find(
    (n) => n.type === 'project.join_request' && n.payload.projectId === project.id,
  )?.payload.shareToken;
  expect(requestToken, 'A got no join request').toBeDefined();
  await dataOf(
    await a.request.post('/api/v1/decisions/respond', { data: { token: requestToken, action: 'decline' } }),
    'A declines',
  );

  await a.close();
  await b.close();
});

test('a bell with more notifications than the window holds scrolls them, and the last one can be read', async ({ browser }) => {
  const a = await browser.newContext();
  const page = await a.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    userId: 'u-self',
    type: 'studio.invite_accepted',
    payload: {},
    projectId: null,
    readAt: null,
    expiresAt: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  }));
  await page.route(/\/api\/v1\/users\/me\/notifications\?unread=true/, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { items, resolved: { users: {}, studios: {}, projects: {} } } }),
  }));

  await page.goto('/studio');
  await page.getByTestId('bell-trigger').click();
  const popover = page.getByTestId('bell-popover');
  const last = popover.getByTestId(`bell-notification-${items[19]!.id}`);
  await expect(last).toHaveCount(1, { timeout: 15_000 });
  // The panel ends inside the window, with its title still on top.
  const box = (await popover.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  await expect(popover.getByTestId('bell-count')).toBeInViewport();

  // The wheel over the list brings the last notification into view.
  const first = (await popover.getByTestId(`bell-notification-${items[0]!.id}`).boundingBox())!;
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  for (let turn = 0; turn < 20; turn += 1) await page.mouse.wheel(0, 400);
  await expect(last).toBeInViewport();
  // Measured again: the first read can land inside the opening zoom.
  const [shown, panel] = [(await last.boundingBox())!, (await popover.boundingBox())!];
  expect(shown.y + shown.height).toBeLessThanOrEqual(panel.y + panel.height);
  expect(panel.y + panel.height).toBeLessThanOrEqual(720);
  await expect(popover.getByTestId('bell-count')).toBeInViewport();

  await a.close();
});
