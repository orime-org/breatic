// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import { expect, test, type APIRequestContext } from 'playwright/test';

import { readAccounts } from '../helpers/credentials';
import { STATE_FILE } from '../helpers/project';

/**
 * Read a `{ data }` envelope, failing with the server's words when the call did.
 * @param res - The response.
 * @param label - What the call was, for the failure message.
 * @returns The data.
 */
async function dataOf<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, label: string): Promise<T> {
  expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test('mark all read clears the news and keeps the request waiting on A', async ({ browser }) => {
  const a = await browser.newContext({ storageState: STATE_FILE.A });
  const b = await browser.newContext({ storageState: STATE_FILE.B });
  const emailB = readAccounts().B?.email;
  expect(emailB, 'setup recorded no second account').toBeDefined();

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
  // Earlier runs may have left requests waiting on A; this one added one more.
  const waiting = await decisions.count();
  expect(waiting).toBeGreaterThanOrEqual(1);

  await markAll.click();
  await expect(popover.locator('[data-testid^="bell-mark-read-"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(decisions).toHaveCount(waiting);
  await expect(markAll).toHaveCount(0);
  await expect(count).toHaveText(String(waiting));
  await expect(page.getByTestId('bell-unread-dot')).toBeVisible();

  await a.close();
  await b.close();
});
