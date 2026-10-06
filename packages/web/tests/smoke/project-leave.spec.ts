// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Leaving a project of one's own accord, end to end.
 *
 * Account A owns the projects; B is an editor on them. B leaves one from its
 * card in the studio, and another from inside the project — once as a studio
 * member, once as an outside collaborator on a project in A's personal
 * studio, which B only reaches through Recent and the project page. The
 * owner is offered neither entry. A sees the leave in the activity feed.
 *
 * Projects are built and B is let in through the API — the part under test is
 * what B does in the browser. The team studio is built once for the file —
 * studios cannot be removed, and creating one is rate limited — and every
 * case makes its own project in it.
 *
 *   pnpm --filter @breatic/web test:smoke project-leave
 */
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from 'playwright/test';

import { readAccounts } from '../helpers/credentials';
import { STATE_FILE, smokeProjectId } from '../helpers/project';

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

interface Made {
  id: string;
  slug: string;
  name: string;
}

/**
 * Create a project as A in a studio.
 * @param a - A's context.
 * @param studioId - The studio.
 * @param slug - Its slug.
 * @param name - Its name.
 * @returns The project.
 */
async function createProject(a: BrowserContext, studioId: string, slug: string, name: string): Promise<Made> {
  const created = await dataOf<{ id: string; name: string }>(
    await a.request.post('/api/v1/projects', { data: { studioId, name, slug, spaceType: 'canvas' } }),
    `create ${name}`,
  );
  return { id: created.id, slug, name: created.name };
}

/**
 * Put B on a project as an editor: A invites, B confirms from the bell.
 * @param a - A's context.
 * @param b - B's context.
 * @param projectId - The project.
 */
async function letBIn(a: BrowserContext, b: BrowserContext, projectId: string): Promise<void> {
  const emailB = readAccounts().B?.email;
  expect(emailB, 'setup recorded no second account').toBeDefined();
  await dataOf(
    await a.request.post(`/api/v1/projects/${projectId}/invitations`, { data: { email: emailB, role: 'editor' } }),
    'invite B to the project',
  );
  const bell = await dataOf<{ items: { type: string; payload: { shareToken?: string; projectId?: string } }[] }>(
    await b.request.get('/api/v1/users/me/notifications'),
    'B bell',
  );
  const token = bell.items.find(
    (n) => n.type === 'project.invite_request' && n.payload.projectId === projectId,
  )?.payload.shareToken;
  expect(token, 'B got no project invite').toBeDefined();
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'B joins');
}

/** A team studio run by A with B in it. */
interface TeamScene {
  a: BrowserContext;
  b: BrowserContext;
  studioId: string;
  studioSlug: string;
}

/**
 * Build the team studio through the API.
 * @param browser - The test's browser.
 * @returns The two signed-in contexts and the studio.
 */
async function buildTeamScene(browser: Browser): Promise<TeamScene> {
  const a = await browser.newContext({ storageState: STATE_FILE.A });
  const b = await browser.newContext({ storageState: STATE_FILE.B });
  const emailB = readAccounts().B?.email;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const studioSlug = `leave-smoke-${stamp}`;
  await dataOf(
    await a.request.post('/api/v1/studios', { data: { name: `Leave smoke ${stamp}`, slug: studioSlug } }),
    'create studio',
  );
  await dataOf(
    await a.request.post(`/api/v1/studio/${studioSlug}/members`, { data: { email: emailB, role: 'maintainer' } }),
    'invite B to the studio',
  );
  const studio = await dataOf<{ id: string }>(await a.request.get(`/api/v1/studio/${studioSlug}`), 'studio');
  const bell = await dataOf<{ items: { type: string; payload: { shareToken?: string; studioId?: string } }[] }>(
    await b.request.get('/api/v1/users/me/notifications'),
    'B bell',
  );
  const token = bell.items.find(
    (n) => n.type === 'studio.invite_request' && n.payload.studioId === studio.id,
  )?.payload.shareToken;
  expect(token, 'B got no studio invite').toBeDefined();
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'B joins studio');

  return { a, b, studioId: studio.id, studioSlug };
}

/**
 * A fresh project in the team studio that B edits.
 * @param scene - The team studio.
 * @param name - Its name.
 * @returns The project.
 */
async function teamProject(scene: TeamScene, name: string): Promise<Made> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const project = await createProject(scene.a, scene.studioId, `leave-target-${stamp}`, `${name} ${stamp}`);
  await letBIn(scene.a, scene.b, project.id);
  return project;
}

/**
 * Open the members list in the project's top bar.
 * @param page - The page, on the project.
 */
async function openMembers(page: Page): Promise<void> {
  const trigger = page.getByTestId('members-trigger');
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await trigger.click();
  await expect(page.getByTestId('members-popover')).toBeVisible();
}

test.describe('in a team studio', () => {
  let scene: TeamScene;

  test.beforeAll(async ({ browser }) => {
    scene = await buildTeamScene(browser);
  });

  test.afterAll(async () => {
    await scene?.a.close();
    await scene?.b.close();
  });

  test('B leaves from the studio card: asks first, Cancel changes nothing, then the card turns into a join card', async () => {
    const { a, b, studioSlug } = scene;
    const target = await teamProject(scene, 'Leave card');
    const page = await b.newPage();
    await page.goto(`/studio/${studioSlug}/projects`);
    const card = page.getByTestId(`project-card-${target.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('Editor')).toBeVisible();

    await card.hover();
    await card.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Leave project' }).click();
    const dialog = page.getByTestId('leave-project-dialog');
    await expect(dialog).toContainText(`Leave “${target.name}”?`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await dataOf<{ myRole: string }>(await b.request.get(`/api/v1/projects/${target.id}`), 'still in')).myRole).toBe(
      'editor',
    );

    await card.hover();
    await card.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Leave project' }).click();
    await page.getByTestId('leave-project-dialog').getByRole('button', { name: 'Leave' }).click();
    await expect(page.getByText(`You left “${target.name}”`)).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('Editor')).toBeHidden();
    await expect(card.getByRole('button', { name: new RegExp(target.name) })).toBeVisible();
    await expect(card.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    expect((await b.request.get(`/api/v1/projects/${target.id}`)).status()).toBe(403);

    // The owner sees it in the feed as B's own act.
    const feed = await dataOf<{ items: { type: string; actorUserId: string | null; payload: { targetUserId?: string } }[] }>(
      await a.request.get(`/api/v1/projects/${target.id}/activities`),
      'A feed',
    );
    const me = await dataOf<{ id: string }>(await b.request.get('/api/v1/auth/me'), 'B me');
    const row = feed.items.find((i) => i.type === 'member:removed');
    expect(row, 'no member:removed row in the feed').toBeDefined();
    expect(row!.actorUserId).toBe(me.id);
    expect(row!.payload.targetUserId).toBe(me.id);
  });

  test('B leaves from inside the project and lands on Recent without it', async () => {
    const { b } = scene;
    const target = await teamProject(scene, 'Leave page');
    const page = await b.newPage();
    await page.goto(`/project/${target.slug}-${target.id}`);
    await openMembers(page);
    await page.getByRole('button', { name: 'Leave project' }).click();
    await page.getByTestId('leave-project-dialog').getByRole('button', { name: 'Leave' }).click();

    await page.waitForURL(/\/studio$/, { timeout: 20_000 });
    await expect(page.getByText(`You left “${target.name}”`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(target.name, { exact: true })).toHaveCount(0);
    expect((await b.request.get(`/api/v1/projects/${target.id}`)).status()).toBe(403);
  });

  test('the owner is offered neither entry', async () => {
    const { a, studioSlug } = scene;
    const target = await teamProject(scene, 'Leave owner');
    const page = await a.newPage();
    await page.goto(`/project/${target.slug}-${target.id}`);
    await openMembers(page);
    await expect(page.getByTestId('members-manage-trigger')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Leave project' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto(`/studio/${studioSlug}/projects`);
    const card = page.getByTestId(`project-card-${target.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.hover();
    await card.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Leave project' })).toHaveCount(0);
  });
});

test('an outside collaborator on a personal-studio project leaves from inside it', async ({ browser }) => {
  const a = await browser.newContext({ storageState: STATE_FILE.A });
  const b = await browser.newContext({ storageState: STATE_FILE.B });
  const anchor = await dataOf<{ studioId: string }>(
    await a.request.get(`/api/v1/projects/${smokeProjectId('A', 0)}`),
    'A personal project',
  );
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const target = await createProject(a, anchor.studioId, `smoke-run-leave-${stamp}`, `Leave outside ${stamp}`);
  try {
    await letBIn(a, b, target.id);
    const page = await b.newPage();
    await page.goto(`/project/${target.slug}-${target.id}`);
    await openMembers(page);
    await page.getByRole('button', { name: 'Leave project' }).click();
    await page.getByTestId('leave-project-dialog').getByRole('button', { name: 'Leave' }).click();

    await page.waitForURL(/\/studio$/, { timeout: 20_000 });
    await expect(page.getByText(`You left “${target.name}”`)).toBeVisible({ timeout: 10_000 });
    expect((await b.request.get(`/api/v1/projects/${target.id}`)).status()).toBe(404);
  } finally {
    // Archived, it leaves A's live project count, which the tier caps.
    await a.request.post(`/api/v1/projects/${target.id}/archive`);
    await a.close();
    await b.close();
  }
});
