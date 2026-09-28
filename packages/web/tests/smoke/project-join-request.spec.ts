// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Joining a project by request, end to end (#96).
 *
 * Account A runs a team studio with B in it and owns its projects; B is on
 * none of them. B sees them in the studio, clicks one, and the join dialog
 * opens in place; B asks, A answers on the decision page as Editor, and B
 * walks in. Opening another project's address directly shows B the same
 * dialog without leaving the address, and Cancel goes back to the studio.
 *
 * The studio and projects are built through the API — the part under test is
 * what B and A do in the browser.
 *
 *   pnpm --filter @breatic/web test:smoke -- project-join-request
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from 'playwright/test';

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

/** A team studio run by A with B in it, and projects A owns that B is not on. */
interface Scene {
  a: BrowserContext;
  b: BrowserContext;
  studioSlug: string;
  projects: { id: string; slug: string; name: string }[];
}

/**
 * Build a fresh scene through the API.
 * @param browser - The test's browser.
 * @param count - How many projects A creates.
 * @returns The two signed-in contexts, the studio and the projects.
 */
async function buildScene(browser: Browser, count: number): Promise<Scene> {
  const a = await browser.newContext({ storageState: STATE_FILE.A });
  const b = await browser.newContext({ storageState: STATE_FILE.B });
  const emailB = readAccounts().B?.email;
  expect(emailB, 'setup recorded no second account').toBeDefined();

  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const studioSlug = `join-smoke-${stamp}`;
  await dataOf(
    await a.request.post('/api/v1/studios', { data: { name: `Join smoke ${stamp}`, slug: studioSlug } }),
    'create studio',
  );
  await dataOf(
    await a.request.post(`/api/v1/studio/${studioSlug}/members`, { data: { email: emailB, role: 'maintainer' } }),
    'invite B',
  );
  const bell = await dataOf<{ items: { type: string; payload: { shareToken?: string; studioId?: string } }[] }>(
    await b.request.get('/api/v1/users/me/notifications'),
    'B bell',
  );
  const studio = await dataOf<{ id: string }>(await a.request.get(`/api/v1/studio/${studioSlug}`), 'studio');
  const token = bell.items.find(
    (n) => n.type === 'studio.invite_request' && n.payload.studioId === studio.id,
  )?.payload.shareToken;
  expect(token, 'B got no studio invite').toBeDefined();
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'B joins');

  const projects: Scene['projects'] = [];
  for (let n = 1; n <= count; n++) {
    const slug = `join-target-${stamp}-${n}`;
    const created = await dataOf<{ id: string; name: string }>(
      await a.request.post('/api/v1/projects', {
        data: { studioId: studio.id, name: `Join target ${n}`, slug, spaceType: 'canvas' },
      }),
      `create project ${n}`,
    );
    projects.push({ id: created.id, slug, name: created.name });
  }
  return { a, b, studioSlug, projects };
}

/**
 * Open the studio's Projects tab as B and find a project's card.
 * @param page - B's page.
 * @param studioSlug - The studio.
 * @param name - The project's name.
 * @returns The card's clickable element.
 */
async function cardOf(page: Page, studioSlug: string, name: string) {
  await page.goto(`/studio/${studioSlug}/projects`);
  const card = page.getByRole('button', { name: new RegExp(name) });
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

test('B asks to join from the card; A approves as Editor; B walks in', async ({ browser }) => {
  const { a, b, studioSlug, projects } = await buildScene(browser, 1);
  const target = projects[0]!;
  const pageB = await b.newPage();

  await (await cardOf(pageB, studioSlug, target.name)).click();
  const dialog = pageB.getByTestId('join-project-dialog');
  await expect(dialog.getByText('You\'re not a member of this project')).toBeVisible();
  expect(pageB.url()).toContain(`/studio/${studioSlug}/projects`);
  await dialog.getByLabel('Message to the owner (optional)').fill('I cut the trailer');
  await dialog.getByRole('button', { name: 'Request to join' }).click();
  await expect(dialog.getByText('Request sent')).toBeVisible();
  await dialog.getByRole('button', { name: 'OK' }).click();

  // Asking again shows the pending request instead of a second one.
  await (await cardOf(pageB, studioSlug, target.name)).click();
  await expect(pageB.getByTestId('join-project-dialog').getByText('Request pending')).toBeVisible();
  await pageB.keyboard.press('Escape');

  const pageA = await a.newPage();
  await pageA.goto(`/studio/${studioSlug}/projects`);
  await pageA.getByTestId('bell-trigger').click();
  const row = pageA.locator('[data-testid^="bell-open-decision-"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(pageA.getByText(/asked to join Join target 1/)).toBeVisible({ timeout: 15_000 });
  await expect(pageA.getByText(/I cut the trailer/)).toBeVisible();
  await pageA.getByRole('combobox', { name: 'Role' }).click();
  await pageA.getByRole('option', { name: 'Editor' }).click();
  await pageA.getByRole('button', { name: 'Approve' }).click();
  await pageA.waitForURL(new RegExp(`/project/${target.slug}-${target.id}`), { timeout: 20_000 });

  const detail = await dataOf<{ myRole: string }>(await b.request.get(`/api/v1/projects/${target.id}`), 'B opens');
  expect(detail.myRole).toBe('editor');
  await pageB.goto(`/studio/${studioSlug}/projects`);
  const link = pageB.getByRole('link', { name: new RegExp(target.name) });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await link.click();
  await pageB.waitForURL(new RegExp(`/project/${target.slug}-${target.id}`), { timeout: 20_000 });
  await expect(pageB.getByTestId('project-page')).toBeVisible({ timeout: 30_000 });
  await a.close();
  await b.close();
});

test('B opening a project address directly gets the dialog in place; Cancel goes back to the studio', async ({
  browser,
}) => {
  const { a, b, studioSlug, projects } = await buildScene(browser, 1);
  const target = projects[0]!;
  const pageB = await b.newPage();
  const address = `/project/${target.slug}-${target.id}`;
  await pageB.goto(address);

  const dialog = pageB.getByTestId('join-project-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/Join target 1/)).toBeVisible();
  expect(new URL(pageB.url()).pathname).toBe(address);

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await pageB.waitForURL(new RegExp(`/studio/${studioSlug}/projects$`), { timeout: 20_000 });
  await a.close();
  await b.close();
});
