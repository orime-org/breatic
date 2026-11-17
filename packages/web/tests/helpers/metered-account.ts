// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * An account of a case's own on a real membership tier, and the cheapest
 * press of Generate, for the smoke cases about tier limits (inner#1034,
 * inner#1968).
 *
 * The suite's shared accounts are on `self_hosted`, whose limits nobody
 * reaches, and other cases rely on that, so a case about a tier's limit makes
 * an account of its own with the scripts setup uses and moves it back to
 * `self_hosted` at the end.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { expect, type Browser, type BrowserContext, type Page } from 'playwright/test';

import { dataOf } from './api';
import { MADE_BY_SMOKE } from './project';
import { visibleSpace } from './space';

/** The repository root, where the account scripts run from. */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Run one of the suite's account scripts the way setup runs `seed-smoke-account.ts`.
 * @param script - The file under `scripts/`.
 * @param input - What the script reads from stdin.
 * @returns What the script printed.
 * @throws {Error} When the script fails, with what it printed.
 */
export function runScript(script: string, input: object): string {
  try {
    return execFileSync(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', `scripts/${script}`],
      { cwd: REPO_ROOT, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim() ?? String(err);
    throw new Error(`scripts/${script} failed: ${said.slice(-400)}`);
  }
}

/** What {@link makeMeteredAdmin} has made so far. */
export interface MadeSoFar {
  userId?: string;
  context?: BrowserContext;
  projectId?: string;
}

/** An admin of its own on `base`, signed in, with a canvas project in its personal studio. */
export interface MeteredAdmin {
  context: BrowserContext;
  userId: string;
  studioId: string;
  projectId: string;
}

/**
 * Make an admin on `base` with a personal studio and one canvas project.
 * Whatever this returns is undone by {@link releaseMeteredAdmin}.
 * @param browser - The browser.
 * @param label - A word naming the case, for the account and project names.
 * @param made - Receives the account, its context and its project as each
 *   comes to exist, so a failure part way is still undone.
 * @returns The admin.
 */
export async function makeMeteredAdmin(
  browser: Browser,
  label: string,
  made: MadeSoFar,
): Promise<MeteredAdmin> {
  const mark = randomBytes(6).toString('hex');
  const admin = { email: `smoke-${label}-${mark}@breatic.test`, password: randomBytes(18).toString('base64url') };
  const { userId } = JSON.parse(runScript('seed-smoke-account.ts', admin)) as { userId: string };
  made.userId = userId;
  runScript('set-smoke-tier.ts', { userId, tier: 'base' });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  made.context = context;
  const api = context.request;
  await dataOf(await api.post('/api/v1/auth/login', { data: admin }), 'sign the admin in');
  await dataOf(await api.post('/api/v1/auth/setup-studio', { data: { slug: `smoke-${label}-${mark}` } }), 'create the admin personal studio');
  const studios = await dataOf<Array<{ id: string; type: string }>>(await api.get('/api/v1/studios'), 'list studios');
  const studioId = studios.find((studio) => studio.type === 'personal')?.id;
  if (studioId === undefined) throw new Error('the admin has no personal studio');
  const project = await dataOf<{ id: string }>(
    await api.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { studioId, name: `${label} ${mark}`, slug: `${MADE_BY_SMOKE}-${label}-${mark}`, spaceType: 'canvas' },
    }),
    'create the project',
  );
  made.projectId = project.id;
  return { context, userId, studioId, projectId: project.id };
}

/**
 * Archive the admin's project (which closes its Space), close its browser
 * context and move it back to `self_hosted`, for whatever of that exists.
 * @param made - What {@link makeMeteredAdmin} got as far as making.
 * @param made.userId - The account.
 * @param made.context - Its signed-in context.
 * @param made.projectId - Its project.
 */
export async function releaseMeteredAdmin(made: MadeSoFar): Promise<void> {
  try {
    if (made.context !== undefined && made.projectId !== undefined) {
      const archived = await made.context.request.post(`/api/v1/projects/${made.projectId}/archive`);
      expect(archived.ok(), `archive the case's project: ${archived.status()}`).toBe(true);
    }
  } finally {
    await made.context?.close();
    if (made.userId !== undefined) runScript('set-smoke-tier.ts', { userId: made.userId, tier: 'self_hosted' });
  }
}

/**
 * Open a project on its one canvas Space.
 * @param page - A page signed in as someone in the project.
 * @param projectId - The project.
 * @returns The canvas Space's id.
 */
export async function openCanvas(page: Page, projectId: string): Promise<string> {
  await page.goto(`/project/${projectId}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const tab = await page.locator('[data-testid^="space-tab-name-"]').first().getAttribute('data-testid');
  const spaceId = (tab ?? '').replace('space-tab-name-', '');
  expect(spaceId).not.toBe('');
  return spaceId;
}

/**
 * Open a node's generate panel, set the panel's default model to its cheapest
 * settings (low quality, 1K, docs/TEST-MANDATE.md 2.2) and press Generate.
 * @param page - The project page.
 * @param nodeId - The empty image node.
 */
export async function pressGenerate(page: Page, nodeId: string): Promise<void> {
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  const box = await node.boundingBox();
  if (box === null) throw new Error(`node ${nodeId} has no box`);
  await node.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.x + box.width / 2, clientY: box.y + 8 });
  await page.getByTestId('node-menu-generate').click();
  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('A red apple on a white table');
  const ratio = page.getByTestId('generate-ratio-trigger');
  await ratio.click();
  await page.getByTestId('generate-resolution-option-1k').click();
  await page.getByTestId('generate-param-quality-option-low').click();
  await ratio.click();
  await expect(page.locator('[data-radix-popper-content-wrapper]')).toHaveCount(0);
  await expect(ratio).toContainText('Low');
  const execute = page.getByTestId('generate-execute');
  await expect(execute).toBeEnabled({ timeout: 20_000 });
  await execute.click();
}
