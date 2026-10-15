// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A membership change reaches the canvas someone already has open (inner#911).
 *
 * A builds a team studio with B in it and a project in it; both open the
 * project's canvas. The cases write to the canvas from B's page and read it
 * from A's, so "B's write landed" means the server accepted it and passed it
 * on.
 *
 *   - A removes B from the studio: B's page turns into the not-found screen,
 *     and a write B's page still makes does not reach A.
 *   - B, a viewer, asks to edit and A approves: without reloading, B's next
 *     write reaches A.
 *
 * Studios cannot be removed and creating one is rate limited, so each case
 * builds its own and leaves it.
 *
 *   pnpm --filter @breatic/web test:smoke member-revocation
 */
import { expect, type Browser, type BrowserContext, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';

import { credentialsFor } from '../helpers/credentials';
import { dataOf } from '../helpers/api';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';

/**
 * The share token of a request notification, once it is in the bell.
 * @param ctx - Whose bell.
 * @param type - The notification type.
 * @param key - The payload field that identifies the subject.
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

/** A team studio run by A, with B in it, and one project both have open. */
interface Scene {
  a: BrowserContext;
  b: BrowserContext;
  pageA: Page;
  pageB: Page;
  studioSlug: string;
  projectId: string;
  spaceId: string;
  bId: string;
}

/**
 * Build the studio and project through the API, put B on the project with a
 * role, and open its canvas on both pages.
 * @param browser - The test's browser.
 * @param role - B's project role.
 * @returns The scene.
 */
async function buildScene(browser: Browser, role: 'editor' | 'viewer'): Promise<Scene> {
  const a = await browser.newContext();
  const b = await browser.newContext({ storageState: stateFile('B') });
  const emailB = credentialsFor('B').email;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const studioSlug = `revoke-${stamp}`;
  await dataOf(await a.request.post('/api/v1/studios', { data: { name: `Revoke ${stamp}`, slug: studioSlug } }), 'create studio');
  await dataOf(
    await a.request.post(`/api/v1/studio/${studioSlug}/members`, { data: { email: emailB, role: 'maintainer' } }),
    'invite B to the studio',
  );
  const studio = await dataOf<{ id: string }>(await a.request.get(`/api/v1/studio/${studioSlug}`), 'studio');
  const studioToken = await tokenFrom(b, 'studio.invite_request', 'studioId', studio.id);
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token: studioToken, action: 'confirm' } }), 'B joins studio');

  const project = await dataOf<{ id: string }>(
    await a.request.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { studioId: studio.id, name: `Revoke target ${stamp}`, slug: `revoke-target-${stamp}`, spaceType: 'canvas' },
    }),
    'create project',
  );
  await dataOf(
    await a.request.post(`/api/v1/projects/${project.id}/invitations`, { data: { email: emailB, role } }),
    'invite B to the project',
  );
  const projectToken = await tokenFrom(b, 'project.invite_request', 'projectId', project.id);
  await dataOf(await b.request.post('/api/v1/decisions/respond', { data: { token: projectToken, action: 'confirm' } }), 'B joins project');
  const { id: bId } = await dataOf<{ id: string }>(await b.request.get('/api/v1/auth/me'), 'me B');

  const pageA = await a.newPage();
  const pageB = await b.newPage();
  await pageA.goto(`/project/${project.id}`);
  await pageB.goto(`/project/${project.id}`);
  for (const page of [pageA, pageB]) await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 });
  const tab = await pageB.locator('[data-testid^="space-tab-name-"]').first().getAttribute('data-testid');
  if (tab === null) throw new Error('no Space tab on B');
  return { a, b, pageA, pageB, studioSlug, projectId: project.id, spaceId: tab.replace('space-tab-name-', ''), bId };
}

/**
 * Run a statement against the live canvas module on a page.
 * @param scene - The scene.
 * @param page - Whose page.
 * @param body - The statement; `canvas`, `pid`, `sid` and `extra` are in scope.
 * @param extra - A value passed through as `extra`.
 * @returns What the statement returned.
 */
async function onCanvas<T>(scene: Scene, page: Page, body: string, extra: unknown = null): Promise<T> {
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([at, pid, sid, src, arg]: [string, string, string, string, unknown]) => {
      const canvas = await import(/* @vite-ignore */ at);
      return (new Function('canvas', 'pid', 'sid', 'extra', src) as (c: unknown, p: string, s: string, e: unknown) => unknown)(
        canvas, pid, sid, arg,
      );
    },
    [url, scene.projectId, scene.spaceId, body, extra] as [string, string, string, string, unknown],
  ) as Promise<T>;
}

/**
 * Write a text node from B's page.
 * @param scene - The scene.
 * @param id - The node id.
 */
async function writeFromB(scene: Scene, id: string): Promise<void> {
  await onCanvas(
    scene,
    scene.pageB,
    `canvas.addNode(pid, sid, { id: extra, type: 'text', position: { x: 40, y: 40 },
      data: { createdAt: Date.now(), createdBy: 'member-revocation', locked: false, attachments: [], name: extra, content: extra } });`,
    id,
  );
}

/**
 * Whether A's canvas holds a node.
 * @param scene - The scene.
 * @param id - The node id.
 * @returns True once it is there.
 */
async function seenByA(scene: Scene, id: string): Promise<boolean> {
  const ids = await onCanvas<string[]>(scene, scene.pageA, 'return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);');
  return ids.includes(id);
}

test('removing a member from the studio closes their open canvas and stops their writes', async ({ browser }) => {
  test.setTimeout(120_000);
  const scene = await buildScene(browser, 'editor');
  try {
    await writeFromB(scene, 'before-removal');
    await expect.poll(() => seenByA(scene, 'before-removal')).toBe(true);

    const removedAt = Date.now();
    await dataOf(await scene.a.request.delete(`/api/v1/studio/${scene.studioSlug}/members/${scene.bId}`), 'remove B');

    await expect(scene.pageB.getByTestId('not-found-page')).toBeVisible({ timeout: 5_000 });
    // The not-found screen comes after the close, so this bounds the close too.
    const elapsed = Date.now() - removedAt;
    test.info().annotations.push({ type: 'removal to not-found (ms)', description: String(elapsed) });
    expect(elapsed).toBeLessThanOrEqual(2_000);

    await writeFromB(scene, 'after-removal').catch(() => undefined);
    await scene.pageA.waitForTimeout(3_000);
    expect(await seenByA(scene, 'after-removal')).toBe(false);
  } finally {
    await scene.a.close();
    await scene.b.close();
  }
});

test('an approved upgrade lets a viewer edit without reloading', async ({ browser }) => {
  test.setTimeout(120_000);
  const scene = await buildScene(browser, 'viewer');
  try {
    await writeFromB(scene, 'as-viewer');
    await scene.pageA.waitForTimeout(2_000);
    expect(await seenByA(scene, 'as-viewer')).toBe(false);

    await dataOf(
      await scene.b.request.post(`/api/v1/projects/${scene.projectId}/role-upgrade-requests`, { data: {} }),
      'B asks to edit',
    );
    const token = await tokenFrom(scene.a, 'access.role_upgrade_request', 'projectId', scene.projectId);
    const approvedAt = Date.now();
    await dataOf(await scene.a.request.post('/api/v1/decisions/respond', { data: { token, action: 'confirm' } }), 'A approves');

    let attempt = 0;
    await expect
      .poll(async () => {
        attempt += 1;
        await writeFromB(scene, `as-editor-${String(attempt)}`);
        return seenByA(scene, `as-editor-${String(attempt)}`);
      }, { timeout: 5_000 })
      .toBe(true);
    test.info().annotations.push({ type: 'approval to first accepted write (ms)', description: String(Date.now() - approvedAt) });
  } finally {
    await scene.a.close();
    await scene.b.close();
  }
});
