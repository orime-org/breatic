// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * An account whose monthly operations are used up (inner#1968, test spec K-01
 * and K-02): with fewer than 0.5 credits in the studio, Generate is refused
 * with a top-up that opens the credits overlay; once the studio holds credits
 * again, Generate runs as an operation past the allowance, the membership
 * panel counts it, and both the account's Spending page and the studio ledger
 * show its 0.5 charge as an operation overage.
 *
 * Each case makes an admin of its own on `base` (500 operations a month),
 * fills the month with counted operations and charges the studio's trial
 * credits down to 0.4 (K-01) or 0 (K-02) (`scripts/seed-smoke-operations.ts`), then moves the
 * admin back to `self_hosted`. The one generation that runs uses the panel's
 * default model at its cheapest settings (docs/TEST-MANDATE.md 2.2). Paying
 * is not under test here, so the top-up is a back-office operator gift written
 * to the database (`scripts/grant-smoke-credits.ts`).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { makeMeteredAdmin, type MadeSoFar, openCanvas, pressGenerate, releaseMeteredAdmin, runScript } from '../helpers/metered-account';
import { seedNode } from '../helpers/mini-tool';
import { test } from '../helpers/slot';
import { visibleSpace } from '../helpers/space';

/** The English catalog the suite's accounts read the product in. */
const EN = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/en.json'), 'utf8')) as Record<string, unknown>;

/** How long one cheapest generation may take to land (the model's `generation_time` is 120 s). */
const GENERATION_WAIT_MS = 5 * 60_000;

/**
 * A locale key's English text with its placeholders filled.
 * @param key - The dotted key.
 * @param values - The placeholder values.
 * @returns The text.
 */
function say(key: string, values: Record<string, string> = {}): string {
  const found = key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], EN);
  if (typeof found !== 'string') throw new Error(`no English text at ${key}`);
  return found.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`);
}

/**
 * Open the membership panel from the account menu and return its operations row.
 * @param page - A page of the admin's.
 * @returns The row.
 */
async function operationsRow(page: Page): Promise<Locator> {
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByTestId('account-menu').getByRole('menuitem', { name: 'Membership' }).click();
  const row = page.getByTestId('quota-operations');
  await expect(row).toBeVisible({ timeout: 20_000 });
  return row;
}

/**
 * Seed an empty image node on the project's canvas and press Generate on it.
 * @param page - The admin's page.
 * @param projectId - The project.
 * @returns The node's id.
 */
async function generateOnce(page: Page, projectId: string): Promise<string> {
  const spaceId = await openCanvas(page, projectId);
  const nodeId = randomUUID();
  await seedNode(page, { projectId, spaceId }, nodeId, 'image', 0, { name: 'over-allowance', state: 'idle' });
  // The generate panel opens over the bottom right, where the minimap sits.
  await page.getByTestId('viewport-toolbar').getByRole('button', { name: 'Hide minimap', exact: true }).click();
  await pressGenerate(page, nodeId);
  return nodeId;
}

/**
 * The refusal toast, checked to carry its top-up.
 * @param page - The admin's page.
 * @returns The toast.
 */
async function refusal(page: Page): Promise<Locator> {
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: say('server.operation.exhausted', { credits: '0.5' }) });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast.getByRole('button', { name: say('credits.topUp') })).toBeVisible();
  return toast;
}

test('used-up operations with under 0.5 credits refuse Generate and offer a top-up @needs-model', async ({ browser }) => {
  const made: MadeSoFar = {};
  try {
    const admin = await makeMeteredAdmin(browser, 'ops-out', made);
    runScript('seed-smoke-operations.ts', { userId: admin.userId, studioId: admin.studioId, leaveCredits: 0.4 });
    const page = await admin.context.newPage();

    const row = await operationsRow(page);
    await expect(row).toContainText(say('membership.quotaValue', { used: '500', limit: '500' }));
    await expect(row).toContainText(say('membership.operations.remaining', { count: '0' }));
    await expect(row).toContainText(say('membership.operations.overagePrice', { credits: '0.5' }));

    const nodeId = await generateOnce(page, admin.projectId);
    const toast = await refusal(page);
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node.getByTestId('task-count-running')).toHaveCount(0);
    await toast.getByRole('button', { name: say('credits.topUp') }).click();
    await expect(page.getByTestId('credits-index')).toBeVisible({ timeout: 15_000 });
  } finally {
    await releaseMeteredAdmin(made);
  }
});

test('after a top-up, Generate past the allowance runs, is charged 0.5 and shows on both ledgers @needs-model', async ({ browser }) => {
  // One real generation.
  test.setTimeout(10 * 60_000);
  const made: MadeSoFar = {};
  try {
    const admin = await makeMeteredAdmin(browser, 'ops-topup', made);
    runScript('seed-smoke-operations.ts', { userId: admin.userId, studioId: admin.studioId, leaveCredits: 0 });
    const page = await admin.context.newPage();

    const nodeId = await generateOnce(page, admin.projectId);
    await refusal(page);

    runScript('grant-smoke-credits.ts', { userId: admin.userId, studioId: admin.studioId, credits: '20' });
    await openCanvas(page, admin.projectId);
    await pressGenerate(page, nodeId);
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node.getByTestId('task-count-done')).toBeVisible({ timeout: GENERATION_WAIT_MS });
    await expect(node.getByTestId('task-count-failed')).toHaveCount(0);

    const row = await operationsRow(page);
    await expect(row).toContainText(say('membership.operations.overageCount', { count: '1' }), { timeout: 20_000 });
    await page.keyboard.press('Escape');

    // The account's Spending page reads the overage line (the ledger wire schema knows its kind).
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByTestId('account-menu').getByRole('menuitem', { name: /credit/i }).click();
    await expect(page.getByTestId('credits-index')).toBeVisible({ timeout: 15_000 });
    await page.locator('#credits-tab-ledger').click();
    const spent = page.locator('tr').filter({ hasText: say('credits.eventOperationOverage') });
    await expect(spent).toHaveCount(1, { timeout: 20_000 });
    await expect(spent).toContainText('0.5');
    await expect(page.getByText(say('credits.loadFailed'))).toHaveCount(0);
    await expect(page.getByText(say('credits.listPageFailed'))).toHaveCount(0);

    // The studio ledger names it an operation overage, not a generation.
    const studios = await dataOf<Array<{ id: string; slug: string }>>(await admin.context.request.get('/api/v1/studios'), 'list studios');
    const slug = studios.find((studio) => studio.id === admin.studioId)?.slug;
    expect(slug, 'the studio slug').toBeDefined();
    await page.goto(`/studio/${slug}/credits`);
    const line = page.locator('tr[data-testid^="studio-ledger-"]').filter({ hasText: say('credits.eventOperationOverage') });
    await expect(line).toHaveCount(1, { timeout: 20_000 });
    await expect(line).toContainText('0.5');
    await expect(page.getByText(say('studio.container.credits.loadError'))).toHaveCount(0);
  } finally {
    await releaseMeteredAdmin(made);
  }
});
