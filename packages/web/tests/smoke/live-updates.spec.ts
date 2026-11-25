// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What an open page learns without asking (#1580, test spec area N): a Project transfer and a join request reach the
 * bell, a declined transfer leaves the members dialog, a focus crop lands in its node's pool after its uploader left,
 * and a Project page left alone sends no periodic request.
 *
 * The scene is built through the API; what is under test is what the open pages show.
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/live-updates.spec.ts
 */

import { randomUUID } from 'node:crypto';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { seedNode } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { visibleSpace } from '../helpers/space';
import { stateFile, test } from '../helpers/slot';

/** A Studio of A's with B in it, and a Project there that both are on, opened on both pages. */
interface Scene {
  a: BrowserContext;
  b: BrowserContext;
  pageA: Page;
  pageB: Page;
  studioId: string;
  projectId: string;
  bId: string;
  stamp: string;
}

/**
 * The share token of the newest notification of `type` whose payload names `value` under `key`.
 * @param ctx - Whose bell.
 * @param type - The notification type.
 * @param key - The payload field.
 * @param value - Its value.
 * @returns The token.
 */
async function tokenFrom(ctx: BrowserContext, type: string, key: string, value: string): Promise<string> {
  let token: string | undefined;
  await expect
    .poll(async () => {
      const bell = await dataOf<{ items: { type: string; payload: Record<string, string | undefined> }[] }>(
        await ctx.request.get('/api/v1/users/me/notifications'),
        'bell',
      );
      token = bell.items.find((n) => n.type === type && n.payload[key] === value)?.payload.shareToken;
      return token;
    }, { timeout: 10_000 })
    .toBeDefined();
  return token as string;
}

/**
 * Build the scene: A's Studio with B as a maintainer, a canvas Project with B on it as an editor, open on both pages.
 * @param browser - The test's browser.
 * @returns The scene.
 */
async function buildScene(browser: Browser): Promise<Scene> {
  const a = await browser.newContext();
  const b = await browser.newContext({ storageState: stateFile('B') });
  const emailB = credentialsFor('B').email;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const studioSlug = `live-${stamp}`;
  await dataOf(await a.request.post('/api/v1/studios', { data: { name: `Live ${stamp}`, slug: studioSlug } }), 'create studio');
  await dataOf(
    await a.request.post(`/api/v1/studio/${studioSlug}/members`, { data: { email: emailB, role: 'maintainer' } }),
    'invite B to the studio',
  );
  const studio = await dataOf<{ id: string }>(await a.request.get(`/api/v1/studio/${studioSlug}`), 'studio');
  const studioToken = await tokenFrom(b, 'studio.invite_request', 'studioId', studio.id);
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token: studioToken, action: 'confirm' } }), 'B joins studio');
  const project = await createProject(a, studio.id, stamp, 'p1');
  await dataOf(
    await a.request.post(`/api/v1/projects/${project}/invitations`, { data: { email: emailB, role: 'editor' } }),
    'invite B to the project',
  );
  const projectToken = await tokenFrom(b, 'project.invite_request', 'projectId', project);
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token: projectToken, action: 'confirm' } }), 'B joins project');
  const { id: bId } = await dataOf<{ id: string }>(await b.request.get('/api/v1/auth/me'), 'me B');
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await pageA.goto(`/project/${project}`);
  await pageB.goto(`/project/${project}`);
  for (const page of [pageA, pageB]) await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  return { a, b, pageA, pageB, studioId: studio.id, projectId: project, bId, stamp };
}

/**
 * Create a canvas Project in a Studio.
 * @param ctx - Whose request.
 * @param studioId - The Studio.
 * @param stamp - This run's stamp.
 * @param suffix - Tells this run's Projects apart.
 * @returns Its id.
 */
async function createProject(ctx: BrowserContext, studioId: string, stamp: string, suffix: string): Promise<string> {
  const project = await dataOf<{ id: string }>(
    await ctx.request.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { studioId, name: `Live ${suffix} ${stamp}`, slug: `live-${suffix}-${stamp}`, spaceType: 'canvas' },
    }),
    'create project',
  );
  return project.id;
}

/**
 * Open the bell and return the requests it lists.
 * @param page - Whose page.
 * @returns The request rows in the open popover.
 */
async function openBell(page: Page): Promise<Locator> {
  await page.getByTestId('bell-trigger').click();
  const popover = page.getByTestId('bell-popover');
  await expect(popover).toBeVisible();
  return popover.locator('[data-testid^="bell-open-decision-"]');
}

test('N-01 and N-02 a transfer reaches the bell of the open page, and its refusal leaves the open members dialog', async ({ browser }) => {
  const scene = await buildScene(browser);
  try {
    const requestsB = await openBell(scene.pageB);
    const before = await requestsB.count();
    await dataOf(
      await scene.a.request.post(`/api/v1/projects/${scene.projectId}/transfer-owner`, { data: { toUserId: scene.bId } }),
      'A offers the project to B',
    );
    // N-01: the request shows in B's open bell, with no reload.
    await expect(requestsB).toHaveCount(before + 1, { timeout: 10_000 });

    await scene.pageA.getByTestId('members-trigger').click();
    await scene.pageA.getByTestId('members-manage-trigger').click();
    const pending = scene.pageA.getByTestId('members-modal-transfer-pending');
    await expect(pending).toBeVisible({ timeout: 10_000 });
    const token = await tokenFrom(scene.b, 'project.transfer_request', 'projectId', scene.projectId);
    await dataOf(await scene.b.request.post('/api/v1/decisions/respond', { data: { token, action: 'decline' } }), 'B declines');
    // N-02: the open dialog stops showing the offer, with no reload.
    await expect(pending).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await scene.a.close();
    await scene.b.close();
  }
});

test('N-03 a join request reaches the bell of the owner\'s open Project page', async ({ browser }) => {
  const scene = await buildScene(browser);
  try {
    const other = await createProject(scene.a, scene.studioId, scene.stamp, 'p2');
    const requestsA = await openBell(scene.pageA);
    const before = await requestsA.count();
    await dataOf(
      await scene.b.request.post(`/api/v1/projects/${other}/join-requests`, { data: { message: 'let me in' } }),
      'B asks to join',
    );
    await expect(requestsA).toHaveCount(before + 1, { timeout: 10_000 });
    const token = await tokenFrom(scene.a, 'project.join_request', 'projectId', other);
    await dataOf(await scene.a.request.post('/api/v1/decisions/respond', { data: { token, action: 'decline' } }), 'A declines');
  } finally {
    await scene.a.close();
    await scene.b.close();
  }
});

const SOURCE_IMAGE = 'https://picsum.photos/id/237/400/300.jpg';

/**
 * Drag across a box, between two points given as fractions of it.
 * @param page - The page.
 * @param box - What is dragged across.
 * @param from - Start, as fractions of the box.
 * @param to - End, as fractions of the box.
 */
async function dragAcross(page: Page, box: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const at = await box.boundingBox();
  if (at === null) throw new Error('the crop box has no box');
  await page.mouse.move(at.x + at.width * from[0], at.y + at.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(at.x + at.width * to[0], at.y + at.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/**
 * Run a statement against the live canvas module on a page.
 * @param page - The page.
 * @param body - The statement; `canvas` and `extra` are in scope.
 * @param extra - A value passed through as `extra`.
 * @returns What the statement returned.
 */
async function onCanvas<T>(page: Page, body: string, extra: unknown): Promise<T> {
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([at, src, arg]: [string, string, unknown]) => {
      const canvas = await import(/* @vite-ignore */ at);
      return (new Function('canvas', 'extra', src) as (c: unknown, e: unknown) => unknown)(canvas, arg);
    },
    [url, body, extra] as [string, string, unknown],
  ) as Promise<T>;
}

/**
 * The Space of the first tab on a Project page.
 * @param page - The page.
 * @returns Its id.
 */
async function firstSpace(page: Page): Promise<string> {
  const tab = await page.locator('[data-testid^="space-tab-name-"]').first().getAttribute('data-testid');
  if (tab === null) throw new Error('no Space tab');
  return tab.replace('space-tab-name-', '');
}

test('N-04 a focus crop lands in its node\'s pool after its uploader closed the page @needs-internet @needs-ingest @needs-storage', async ({ browser }) => {
  const uploader = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(uploader);
  const projectId = smokeProjectId();
  await expect(visibleSpace(uploader).locator('.react-flow')).toBeVisible({ timeout: 30_000 });
  const spaceId = await firstSpace(uploader);
  const source = randomUUID();
  const host = randomUUID();
  const watcher = await (await browser.newContext()).newPage();
  try {
    await seedNode(uploader, { projectId, spaceId }, source, 'image', 0, { content: SOURCE_IMAGE, mimeType: 'image/jpeg', size: 40_000 });
    await expect(
      visibleSpace(uploader).locator(`.react-flow__node[data-id="${source}"] [data-testid=image-node-img]`),
    ).toBeVisible({ timeout: 20_000 });
    await seedNode(uploader, { projectId, spaceId }, host, 'image', 600);
    await visibleSpace(uploader).locator(`.react-flow__node[data-id="${host}"]`).click({ button: 'right' });
    await uploader.getByTestId('node-menu-generate').click();
    await uploader.getByTestId('generate-tool-focus').click();
    const node = visibleSpace(uploader).locator(`.react-flow__node[data-id="${source}"]`);
    await node.click();
    const layer = node.getByTestId('focus-crop-layer');
    await expect(layer).toBeVisible({ timeout: 15_000 });
    // A crop of the same picture with the same box is the same bytes, which the Studio already holds after an earlier
    // run and answers as a dedup hit with no upload; a box of its own keeps this crop new.
    await dragAcross(uploader, layer, [0.2, 0.2], [0.55 + Math.random() * 0.2, 0.6 + Math.random() * 0.2]);

    const finished = uploader.waitForResponse(
      (r) => /\/assets\/uploads\/[^/]+\/complete$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await uploader.getByTestId('focus-crop-confirm').click();
    expect((await finished).status()).toBe(202);
    // The uploader leaves while the crop is still being registered.
    await uploader.close();

    await watcher.goto(`/project/${projectId}`);
    await expect(visibleSpace(watcher).locator(`.react-flow__node[data-id="${host}"]`)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => onCanvas<number>(
          watcher,
          'const [pid, sid, id] = extra; const n = canvas.readCanvasGraph(pid, sid).nodes.find((x) => x.id === id); return Array.isArray(n?.data?.focusImages) ? n.data.focusImages.length : 0;',
          [projectId, spaceId, host],
        ),
        { timeout: 60_000 },
      )
      .toBe(1);
  } finally {
    await onCanvas(watcher, 'const [pid, sid, ids] = extra; canvas.removeElements(pid, sid, ids, []);', [projectId, spaceId, [source, host]])
      .catch(() => undefined);
    await watcher.context().close();
  }
});

test('N-09 a Project page left alone with the Agent panel closed sends no periodic request', async ({ page }) => {
  test.setTimeout(240_000);
  await openSmokeProject(page);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 30_000 });
  const toggle = page.getByTestId('agent-toggle');
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // What loading the page asks for has been asked once this has passed.
  await page.waitForTimeout(10_000);
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() !== 'fetch' && request.resourceType() !== 'xhr') return;
    const path = new URL(request.url()).pathname;
    if (path === '/app-version.json') return;
    asked.push(`${request.method()} ${path}`);
  });
  await page.waitForTimeout(120_000);
  expect(asked).toEqual([]);
});
