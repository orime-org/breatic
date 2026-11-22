// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One person's generations past the tier's running-task limit (inner#1968,
 * test spec K-03): the extra ones queue, the earliest queued one starts when a
 * running one ends, and a queued one can be cancelled before it runs.
 *
 * The suite's accounts are on `self_hosted`, whose limit nobody reaches, and
 * other cases rely on that, so this case makes an admin of its own on `base`
 * (`running_tasks_per_user: 2` in `config/membership.yaml`) and moves it back
 * at the end, as `concurrent-editors-cap.spec.ts` does. Four image nodes are
 * generated with the panel's default model at its cheapest settings (low
 * quality, 1K, docs/TEST-MANDATE.md 2.2); the fourth is cancelled while it
 * waits, so three generations are paid for.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { expect, type BrowserContext, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { pressGenerate, runScript } from '../helpers/tier-account';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { seedNode } from '../helpers/mini-tool';
import { MADE_BY_SMOKE } from '../helpers/project';
import { test } from '../helpers/slot';
import { visibleSpace } from '../helpers/space';

/** How long one cheapest generation may take to land (the model's `generation_time` is 120 s). */
const GENERATION_WAIT_MS = 5 * 60_000;

/** One node's task counts as the canvas document holds them. */
interface Counts {
  running: number;
  waiting?: number;
  done: number;
  failed: number;
}

/**
 * Each node's task counts and content, read from the live canvas document.
 * @param page - The project page.
 * @param projectId - The project.
 * @param spaceId - The canvas Space.
 * @returns Counts and content by node id.
 */
async function nodeStates(
  page: Page,
  projectId: string,
  spaceId: string,
): Promise<Record<string, { counts: Counts | null; content: string }>> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data?: { taskCounts?: unknown; content?: string } }[] };
      };
      const out: Record<string, { counts: unknown; content: string }> = {};
      for (const node of canvas.readCanvasGraph(pid, sid).nodes) {
        out[node.id] = { counts: node.data?.taskCounts ?? null, content: node.data?.content ?? '' };
      }
      return JSON.parse(JSON.stringify(out));
    },
    [projectId, spaceId, at] as [string, string, string],
  );
}

/**
 * Open a node's generate panel, set it to its cheapest settings and press Generate.
 * @param page - The project page.
 * @param nodeId - The empty image node.
 */
async function generate(page: Page, nodeId: string): Promise<void> {
  await pressGenerate(page, nodeId);
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node.getByTestId('task-count-running').or(node.getByTestId('task-count-waiting'))).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
}

test('generations past the running-task limit queue, start in turn and cancel while queued @needs-model', async ({ browser }) => {
  // Three real generations, the third only after one of the first two ends.
  test.setTimeout(12 * 60_000);
  const mark = randomBytes(6).toString('hex');
  const admin = { email: `smoke-slots-${mark}@breatic.test`, password: randomBytes(18).toString('base64url') };
  const { userId } = JSON.parse(runScript('seed-smoke-account.ts', admin)) as { userId: string };
  let context: BrowserContext | undefined;
  let projectId: string | undefined;
  try {
    runScript('set-smoke-tier.ts', { userId, tier: 'base' });
    context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const api = context.request;
    await dataOf(await api.post('/api/v1/auth/login', { data: admin }), 'sign the admin in');
    await dataOf(
      await api.post('/api/v1/auth/setup-studio', { data: { slug: `smoke-slots-${mark}` } }),
      'create the admin personal studio',
    );
    const studios = await dataOf<Array<{ id: string; type: string }>>(await api.get('/api/v1/studios'), 'list studios');
    const studioId = studios.find((studio) => studio.type === 'personal')?.id;
    expect(studioId, 'the admin personal studio').toBeDefined();
    const project = await dataOf<{ id: string }>(
      await api.post('/api/v1/projects', {
        headers: { 'Idempotency-Key': randomUUID() },
        data: { studioId, name: `Running slots ${mark}`, slug: `${MADE_BY_SMOKE}-slots-${mark}`, spaceType: 'canvas' },
      }),
      'create the project',
    );
    projectId = project.id;

    const page = await context.newPage();
    await page.goto(`/project/${projectId}`);
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
    const tab = await page.locator('[data-testid^="space-tab-name-"]').first().getAttribute('data-testid');
    const spaceId = (tab ?? '').replace('space-tab-name-', '');
    expect(spaceId).not.toBe('');

    const nodes = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // A node seeded off screen is never rendered, and the camera centres the
    // first one when it lands; zoomed out after that, the other three fit.
    const scale = (): Promise<number> =>
      visibleSpace(page).locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    const zoomOut = page.getByTestId('viewport-toolbar').getByRole('button', { name: 'Zoom out', exact: true });
    for (const [i, id] of nodes.entries()) {
      await seedNode(page, { projectId, spaceId }, id, 'image', i * 320, { name: `slot-${String(i + 1)}`, state: 'idle' });
      if (i === 0) {
        await page.waitForTimeout(1_000);
        await zoomOut.click();
        await zoomOut.click();
        await expect.poll(scale).toBeLessThan(0.8);
      }
    }
    // The generate panel opens over the bottom right, where the minimap sits.
    await page.getByTestId('viewport-toolbar').getByRole('button', { name: 'Hide minimap', exact: true }).click();
    for (const id of nodes) await generate(page, id);
    const [first, second, third, fourth] = nodes as [string, string, string, string];
    const nodeOf = (id: string) => visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);

    // Two run; the third and the fourth wait, and their column says so.
    for (const id of [third, fourth]) {
      await expect(nodeOf(id).getByTestId('task-count-waiting')).toHaveAttribute('aria-label', 'Queued · 1', { timeout: 30_000 });
      await expect(nodeOf(id).getByTestId('task-count-running')).toHaveCount(0);
    }
    for (const id of [first, second]) {
      await expect(nodeOf(id).getByTestId('task-count-waiting')).toHaveCount(0);
    }
    const queued = await nodeStates(page, projectId, spaceId);
    expect(queued[third]?.counts?.waiting).toBe(1);
    expect(queued[first]?.counts?.done ?? 0).toBe(0);
    expect(queued[second]?.counts?.done ?? 0).toBe(0);

    // The fourth is cancelled from its task list while it waits.
    await nodeOf(fourth).getByTestId('task-count-waiting').click();
    const row = page.getByTestId('node-task-row').filter({ has: page.getByTestId('task-waiting') });
    await expect(row).toHaveCount(1);
    await row.getByTestId('task-action-cancel').click();
    await expect(nodeOf(fourth).getByTestId('task-count-waiting')).toHaveCount(0, { timeout: 20_000 });
    await expect(nodeOf(fourth).getByTestId('task-count-failed')).toBeVisible();
    await page.keyboard.press('Escape');
    await nodeOf(fourth).getByTestId('task-count-failed').click();
    await expect(page.getByTestId('node-task-row')).toContainText('Cancelled.');
    await page.keyboard.press('Escape');

    // The third starts only once one of the first two has ended.
    let startedAfter: boolean | undefined;
    await expect
      .poll(
        async () => {
          const now = await nodeStates(page, projectId!, spaceId);
          if ((now[third]?.counts?.waiting ?? 1) > 0) return 'waiting';
          const ended = [first, second].some((id) => (now[id]?.counts?.done ?? 0) + (now[id]?.counts?.failed ?? 0) > 0);
          startedAfter ??= ended;
          return 'started';
        },
        { timeout: GENERATION_WAIT_MS, intervals: [500] },
      )
      .toBe('started');
    expect(startedAfter, 'the third left the queue only after the first or second ended').toBe(true);

    // All three paid runs land; the cancelled one never ran.
    await expect
      .poll(
        async () => {
          const now = await nodeStates(page, projectId!, spaceId);
          return [first, second, third].map((id) => `${String(now[id]?.counts?.done ?? 0)}/${String(now[id]?.counts?.failed ?? 0)}`);
        },
        { timeout: GENERATION_WAIT_MS, intervals: [5_000] },
      )
      .toEqual(['1/0', '1/0', '1/0']);
    const last = await nodeStates(page, projectId, spaceId);
    expect(last[fourth]?.counts).toMatchObject({ running: 0, done: 0, failed: 1 });
    expect(last[fourth]?.content).toBe('');
  } finally {
    if (context !== undefined && projectId !== undefined) {
      // Archiving closes the project's documents, its one Space included.
      const archived = await context.request.post(`/api/v1/projects/${projectId}/archive`);
      expect(archived.ok(), `archive the case's project: ${archived.status()}`).toBe(true);
    }
    await context?.close();
    runScript('set-smoke-tier.ts', { userId, tier: 'self_hosted' });
  }
});
