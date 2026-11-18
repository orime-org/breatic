// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BYOK settings (inner#1953): the avatar menu opens the dialog, the keys tab groups and searches the upstreams, a key
 * that does not connect or is malformed is refused inline and never saved, the models tab with no key points back to
 * the keys tab, and the generation panel still prices a run in credits for an account without a key.
 */

import { randomUUID } from 'node:crypto';

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { seedNode } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

// The Generate panel hangs below its node; a taller window keeps it reachable.
test.use({ viewport: { width: 1440, height: 1000 } });

let made: { page: Page; spaceId: string } | null = null;

test.afterEach(async () => {
  if (made !== null) await deleteSpace(made.page, made.spaceId);
  made = null;
});

/**
 * Open BYOK settings from the personal Studio's account menu.
 * @param page - The signed-in page.
 * @returns The dialog.
 */
async function openByok(page: Page): Promise<Locator> {
  const listed = (await (await page.request.get('/api/v1/studios')).json()) as { data: { slug: string; type: string }[] };
  const personal = listed.data.find((studio) => studio.type === 'personal')!;
  await page.goto(`/studio/${personal.slug}/projects`);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByTestId('account-menu-byok').click();
  const dialog = page.getByTestId('byok-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'BYOK settings' })).toBeVisible();
  return dialog;
}

/**
 * How many keys the account holds, read from the server.
 * @param page - The signed-in page.
 * @returns The count.
 */
async function savedKeys(page: Page): Promise<number> {
  const view = (await (await page.request.get('/api/v1/account/byok')).json()) as { data: { keys: unknown[] } };
  return view.data.keys.length;
}

/**
 * Paste a key for OpenRouter and press Save, waiting for the server's answer.
 * @param page - The page.
 * @param dialog - The BYOK dialog.
 * @param key - The key to paste.
 * @returns The status the save answered and the reason it gave.
 */
async function saveOpenRouterKey(page: Page, dialog: Locator, key: string): Promise<{ status: number; reason: unknown }> {
  await dialog.getByTestId('byok-upstream-openrouter').click();
  const detail = dialog.getByTestId('byok-detail-openrouter');
  await detail.getByPlaceholder('Paste a key').fill(key);
  const answered = page.waitForResponse(
    (res) => res.request().method() === 'PUT' && new URL(res.url()).pathname === '/api/v1/account/byok/keys/openrouter',
    { timeout: 30_000 },
  );
  await detail.getByRole('button', { name: 'Save', exact: true }).click();
  const res = await answered;
  const body = (await res.json().catch(() => ({}))) as { error?: { reason?: unknown } };
  return { status: res.status(), reason: body.error?.reason };
}

/**
 * The top edge of an element.
 * @param target - The element.
 * @returns Its y.
 */
async function topOf(target: Locator): Promise<number> {
  return (await target.boundingBox())!.y;
}

test('the account menu opens BYOK settings on the keys tab, grouped by kind and searchable', async ({ page }) => {
  expect(await savedKeys(page)).toBe(0);
  const dialog = await openByok(page);
  await expect(dialog.getByRole('tab', { name: 'Upstream keys' })).toHaveAttribute('aria-selected', 'true');

  // Nothing added yet: the added group says so, then the language model group, then the resellers.
  const added = dialog.getByText('Added', { exact: true });
  const none = dialog.getByText('None added yet', { exact: true });
  const language = dialog.getByText('Not added · Language model', { exact: true });
  const reseller = dialog.getByText('Not added · Reseller', { exact: true });
  const openrouter = dialog.getByTestId('byok-upstream-openrouter');
  const resellers = ['wavespeed', 'fal', 'sandbase'].map((id) => dialog.getByTestId(`byok-upstream-${id}`));
  for (const shown of [added, none, language, reseller, openrouter, ...resellers]) await expect(shown).toBeVisible();
  const order = [added, none, language, openrouter, reseller, resellers[0]!];
  const tops = await Promise.all(order.map(topOf));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));

  // The first upstream shown is open, with where to get its key.
  const detail = dialog.getByTestId('byok-detail-openrouter');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Get a key from OpenRouter' })).toHaveAttribute('href', /openrouter\.ai/);

  // A search narrows the list, drops the empty added group and opens what it left.
  const search = dialog.getByPlaceholder('Search upstreams');
  await search.fill('fal');
  await expect(dialog.getByTestId('byok-upstream-fal')).toBeVisible();
  await expect(openrouter).toHaveCount(0);
  await expect(dialog.getByTestId('byok-upstream-wavespeed')).toHaveCount(0);
  await expect(added).toHaveCount(0);
  await expect(dialog.getByTestId('byok-detail-fal')).toBeVisible();

  await search.fill('no-such-upstream');
  await expect(dialog.getByText('No matching upstreams', { exact: true })).toBeVisible();
  await expect(dialog.locator('[data-testid^="byok-detail-"]')).toHaveCount(0);

  await search.fill('');
  for (const shown of [openrouter, ...resellers]) await expect(shown).toBeVisible();
});

test('an OpenRouter key OpenRouter turns down is refused inline and nothing is saved @needs-model', async ({ page }) => {
  const dialog = await openByok(page);
  // Well formed, so it reaches OpenRouter's key endpoint, whose answer that it is not a key comes back as the reason.
  expect(await saveOpenRouterKey(page, dialog, `sk-or-v1-${'0'.repeat(64)}`)).toEqual({ status: 422, reason: 'invalid' });

  const detail = dialog.getByTestId('byok-detail-openrouter');
  await expect(detail.getByText('The key is invalid or has been revoked.', { exact: true })).toBeVisible();
  await expect(detail.getByText('Connected', { exact: true })).toHaveCount(0);
  await expect(dialog.getByTestId('byok-status-dot')).toHaveCount(0);
  await expect(dialog.getByText('None added yet', { exact: true })).toBeVisible();
  expect(await savedKeys(page)).toBe(0);
});

test('a key with a space inside is refused without repeating it, and nothing is saved', async ({ page }) => {
  const dialog = await openByok(page);
  const pasted = 'sk-or-v1-abcd efgh-1234567890';
  // Refused by the server's own check, before any upstream is asked.
  expect(await saveOpenRouterKey(page, dialog, pasted)).toEqual({ status: 422, reason: 'key_malformed' });

  const detail = dialog.getByTestId('byok-detail-openrouter');
  await expect(
    detail.getByText('This key is not valid. Check it for extra characters and paste it again.', { exact: true }),
  ).toBeVisible();
  // The key stays in its field and nowhere else on the page.
  expect(await page.locator('body').innerText()).not.toContain('abcd');
  await expect(detail.getByPlaceholder('Paste a key')).toHaveValue(pasted);
  expect(await savedKeys(page)).toBe(0);
});

test('the models tab with no key points back to the keys tab', async ({ page }) => {
  const dialog = await openByok(page);
  await dialog.getByRole('tab', { name: 'Models' }).click();
  await expect(dialog.getByText(/^Add an upstream key, then choose here which upstream each model uses\./)).toBeVisible();
  await dialog.getByRole('button', { name: 'Add a key', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'Upstream keys' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByPlaceholder('Search upstreams')).toBeVisible();
});

test('the generation panel prices a run in credits when the account holds no key', async ({ page }) => {
  const plans: { status: number; body: { data?: { models?: Record<string, unknown> } } }[] = [];
  page.on('response', async (res) => {
    if (/\/api\/v1\/projects\/[^/]+\/key-plan$/.test(new URL(res.url()).pathname)) {
      plans.push({ status: res.status(), body: await res.json().catch(() => ({})) });
    }
  });
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'canvas', `byok-estimate-${Date.now()}`);
  made = { page, spaceId };
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = randomUUID();
  await seedNode(page, { projectId: smokeProjectId(), spaceId }, nodeId, 'image', 0);

  await visibleSpace(page)
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .click({ button: 'right', position: { x: 4, y: 4 } });
  await page.getByTestId('node-menu-generate').click();
  const editor = visibleSpace(page).getByTestId('generate-prompt-editor');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.locator('.ProseMirror').click();
  await page.keyboard.type('a lighthouse at dusk');

  // The estimate waits for the Project's key plan, which names no model on an account key.
  const credit = visibleSpace(page).getByTestId('generate-credit');
  await expect(credit).toHaveText(/\d/, { timeout: 15_000 });
  await expect(credit).not.toContainText('no credits');
  expect(plans.length).toBeGreaterThan(0);
  expect(plans.every((plan) => plan.status === 200 && Object.keys(plan.body.data?.models ?? {}).length === 0)).toBe(true);
});
