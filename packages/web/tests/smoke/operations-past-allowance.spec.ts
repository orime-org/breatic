// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * An account whose monthly operations are used up (inner#1968, test spec K-01
 * and K-02): with fewer than 0.5 credits in the studio, Generate is refused
 * with a top-up that opens the credits overlay; after buying credits through
 * the Stripe sandbox, Generate runs as an operation past the allowance, the
 * membership panel counts it and the credits ledger shows its 0.5 charge.
 *
 * Each case makes an admin of its own on `base` (500 operations a month),
 * fills the month with counted operations and charges the studio's trial
 * credits down to 0.4 (`scripts/seed-smoke-operations.ts`), then moves the
 * admin back to `self_hosted`. The one generation that runs uses the panel's
 * default model at its cheapest settings (docs/TEST-MANDATE.md 2.2), and the
 * purchase is the smallest credit pack.
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

/**
 * Fill and submit the Stripe sandbox checkout with the test card. The card
 * accordion's button is covered, so it is clicked from the page; the address
 * is entered by hand so the autocomplete list does not cover its fields; and
 * saving the details with Link is left off, since it asks for a phone number.
 * @param page - The page on the checkout.
 */
async function payInSandbox(page: Page): Promise<void> {
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  const card = page.getByTestId('card-accordion-item-button');
  await card.waitFor({ state: 'attached', timeout: 30_000 }).catch(() => undefined);
  if ((await card.count()) > 0) await card.evaluate((b) => (b as HTMLElement).click());
  const email = page.locator('#email');
  if ((await email.isVisible()) && (await email.isEditable()) && (await email.inputValue()) === '') await email.fill('smoke-buyer@breatic.test');
  await page.locator('#cardNumber').fill('4242424242424242');
  await page.locator('#cardExpiry').fill('1234');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('Smoke Buyer');
  const country = page.locator('#billingCountry');
  if (await country.isVisible()) await country.selectOption('US');
  const manual = page.getByRole('button', { name: /enter address manually/i });
  if (await manual.isVisible()) await manual.click();
  const line1 = page.locator('#billingAddressLine1');
  if (await line1.isVisible()) {
    await line1.fill('1 Market St');
    await page.locator('#billingLocality').fill('San Francisco');
    await page.locator('#billingPostalCode').fill('94105');
    const state = page.locator('#billingAdministrativeArea');
    if (await state.isVisible()) await state.selectOption('CA');
  } else {
    const postal = page.locator('#billingPostalCode');
    if (await postal.isVisible()) await postal.fill('94105');
  }
  const save = page.locator('#enableStripePass');
  if ((await save.isVisible()) && (await save.isChecked())) await save.uncheck();
  await page.getByTestId('hosted-payment-submit-button').click();
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

test('after a sandbox top-up, Generate past the allowance runs and is charged 0.5 @needs-model @needs-payments', async ({ browser }) => {
  // A Stripe checkout, then one real generation.
  test.setTimeout(10 * 60_000);
  const made: MadeSoFar = {};
  try {
    const admin = await makeMeteredAdmin(browser, 'ops-topup', made);
    runScript('seed-smoke-operations.ts', { userId: admin.userId, studioId: admin.studioId, leaveCredits: 0.4 });
    const page = await admin.context.newPage();
    const api = admin.context.request;

    const nodeId = await generateOnce(page, admin.projectId);
    const toast = await refusal(page);
    await toast.getByRole('button', { name: say('credits.topUp') }).click();
    await expect(page.getByTestId('credits-index')).toBeVisible({ timeout: 15_000 });
    await page.locator('#credits-tab-buy').click();
    // The smallest pack.
    await page.getByTestId('credit-pack').first().getByRole('button').click();
    await page.getByTestId('confirm-consent').click();
    await page.getByTestId('confirm-pay').click();
    await payInSandbox(page);
    await page.waitForURL((url) => url.hostname === 'localhost', { timeout: 60_000 });
    await expect(page.getByTestId('credits-index')).toBeVisible({ timeout: 30_000 });

    const lots = await dataOf<{ items: Array<{ id: string; sourceKind: string; designatedStudioId: string | null }> }>(
      await api.get('/api/v1/credits/lots'),
      'list the lots',
    );
    const bought = lots.items.find((lot) => lot.sourceKind !== 'gift' && lot.designatedStudioId === null);
    expect(bought, 'the purchased lot').toBeDefined();
    await dataOf(
      await api.patch(`/api/v1/credits/lots/${bought!.id}/designation`, { data: { studioId: admin.studioId } }),
      'assign the purchase to the studio',
    );

    await openCanvas(page, admin.projectId);
    await pressGenerate(page, nodeId);
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node.getByTestId('task-count-done')).toBeVisible({ timeout: GENERATION_WAIT_MS });
    await expect(node.getByTestId('task-count-failed')).toHaveCount(0);

    const row = await operationsRow(page);
    await expect(row).toContainText(say('membership.operations.overageCount', { count: '1' }), { timeout: 20_000 });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByTestId('account-menu').getByRole('menuitem', { name: /credit/i }).click();
    await expect(page.getByTestId('credits-index')).toBeVisible({ timeout: 15_000 });
    await page.locator('#credits-tab-ledger').click();
    const overage = page.locator('tr').filter({ hasText: say('credits.eventOperationOverage') });
    await expect(overage).toHaveCount(1, { timeout: 20_000 });
    await expect(overage).toContainText('0.5');
  } finally {
    await releaseMeteredAdmin(made);
  }
});
