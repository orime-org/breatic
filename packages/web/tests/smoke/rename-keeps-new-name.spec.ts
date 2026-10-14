// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1440: once a rename box on the project page closes, the label shows
 * the new name on every frame until its source has it, and goes back to the
 * old name only when the save is refused.
 *
 * Each case records, once per animation frame, what the label shows from the
 * Enter that ends the rename. HTTP renames are held so the wait is long enough
 * to see; the Space rename goes over the collab socket at its own pace.
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

const HOLD_MS = 1500;

let page: Page;
const spaces: string[] = [];

/**
 * Records, once per frame, the text of a label: the field's value while it is
 * open, else the label's text.
 * @param label - CSS selector of the label.
 * @param field - CSS selector of the rename field.
 */
async function record(label: string, field: string): Promise<void> {
  await page.evaluate(
    ([l, f]) => {
      const w = window as unknown as { seen: string[]; stop: boolean };
      w.seen = [];
      w.stop = false;
      const tick = (): void => {
        const box = document.querySelector<HTMLInputElement>(f);
        w.seen.push(box ? box.value : (document.querySelector(l)?.textContent ?? ''));
        if (!w.stop) requestAnimationFrame(tick);
      };
      tick();
    },
    [label, field],
  );
}

/**
 * Stops recording.
 * @returns Every frame's text, in order.
 */
async function seen(): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { seen: string[]; stop: boolean };
    w.stop = true;
    return w.seen;
  });
}

/**
 * Holds every PATCH to the pattern, then answers it as given.
 * @param pattern - The URLs to hold.
 * @param refuse - Answer 500 instead of letting it through.
 */
async function holdPatch(pattern: RegExp, refuse = false): Promise<void> {
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await new Promise((r) => setTimeout(r, HOLD_MS));
    if (refuse) return route.fulfill({ status: 500, body: '{}' });
    return route.fallback();
  });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  await openSmokeProject(page);
});

test.afterEach(async () => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  for (const id of spaces.splice(0)) await deleteSpace(page, id);
  await page.close();
});

test('a Space tab shows its new name on every frame after Enter', async () => {
  const before = `rename-a-${String(Date.now())}`;
  const id = await createSpace(page, 'canvas', before);
  spaces.push(id);
  await page.getByTestId(`space-tab-name-${id}`).click();
  await expect(visibleSpace(page).getByTestId('canvas-space')).toBeVisible({ timeout: 20_000 });
  const tab = page.getByTestId(`space-tab-name-${id}`);
  await tab.dblclick();
  await page.getByTestId(`space-tab-name-input-${id}`).fill(`${before}-b`);
  await record(`[data-testid="space-tab-name-${id}"]`, `[data-testid="space-tab-name-input-${id}"]`);
  await page.keyboard.press('Enter');
  await expect(tab).toHaveText(`${before}-b`);
  await page.waitForTimeout(1500);
  expect(await seen()).not.toContain(before);
});

test('a Space drawer row shows its new name on every frame after Enter', async () => {
  const before = `rename-d-${String(Date.now())}`;
  const id = await createSpace(page, 'canvas', before);
  spaces.push(id);
  await page.getByTestId('space-drawer-trigger').click();
  await page.getByTestId(`space-drawer-menu-${id}`).click();
  await page.getByTestId(`space-drawer-rename-${id}`).click();
  const box = page.getByTestId(`space-drawer-rename-input-${id}`);
  await expect(box).toBeFocused();
  await box.fill(`${before}-b`);
  await record(`[data-testid="space-drawer-name-${id}"]`, `[data-testid="space-drawer-rename-input-${id}"]`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`space-drawer-name-${id}`)).toHaveText(`${before}-b`);
  await page.waitForTimeout(1500);
  expect(await seen()).not.toContain(before);
  await expect(page.getByTestId(`space-tab-name-${id}`)).toHaveText(`${before}-b`);
});

for (const region of ['top-bar', 'agent-column'] as const) {
  const url = region === 'top-bar' ? /\/projects\/[^/]+$/ : /\/chat\/conversations\/[^/]+$/;

  test(`the ${region} title shows its new name on every frame while the save is out`, async () => {
    const title = page.getByTestId(region).getByTestId('title-display');
    await expect(title).toBeVisible({ timeout: 20_000 });
    const before = (await title.textContent()) ?? '';
    await holdPatch(url);
    await title.dblclick();
    await page.getByTestId(region).getByTestId('title-input').fill(`${before}-x`);
    await record(
      `[data-testid="${region}"] [data-testid="title-display"]`,
      `[data-testid="${region}"] [data-testid="title-input"]`,
    );
    await page.keyboard.press('Enter');
    await page.waitForTimeout(HOLD_MS + 1500);
    expect(await seen()).not.toContain(before);
    await expect(title).toHaveText(`${before}-x`);
    // Put it back.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await title.dblclick();
    await page.getByTestId(region).getByTestId('title-input').fill(before);
    await page.keyboard.press('Enter');
    await expect(title).toHaveText(before, { timeout: 10_000 });
  });

  test(`the ${region} title goes back to its old name when the save is refused`, async () => {
    const title = page.getByTestId(region).getByTestId('title-display');
    await expect(title).toBeVisible({ timeout: 20_000 });
    const before = (await title.textContent()) ?? '';
    await holdPatch(url, true);
    await title.dblclick();
    await page.getByTestId(region).getByTestId('title-input').fill(`${before}-x`);
    await page.keyboard.press('Enter');
    await expect(title).toHaveText(`${before}-x`);
    await expect(title).toHaveText(before, { timeout: HOLD_MS + 5000 });
  });
}

test('a history row shows its new name on every frame while the save is out', async () => {
  await holdPatch(/\/chat\/conversations\/[^/]+$/);
  await page.getByTestId('open-conversation-history').click();
  const row = page.getByTestId('conversation-history-list').locator('[data-testid^="conversation-open-"]').first();
  await expect(row).toBeAttached({ timeout: 15_000 });
  const rowId = ((await row.getAttribute('data-testid')) ?? '').replace('conversation-open-', '');
  const before = (await row.locator('span.truncate').first().textContent()) ?? '';
  await page.getByTestId(`conversation-menu-${rowId}`).click();
  await page.getByTestId(`conversation-rename-${rowId}`).click();
  await page.getByTestId('conversation-rename-input').fill(`${before}-x`);
  await record(`[data-testid="conversation-open-${rowId}"] span.truncate`, '[data-testid="conversation-rename-input"]');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(HOLD_MS + 1500);
  expect(await seen()).not.toContain(before);
  // Put it back.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.getByTestId(`conversation-menu-${rowId}`).click();
  await page.getByTestId(`conversation-rename-${rowId}`).click();
  await page.getByTestId('conversation-rename-input').fill(before);
  await page.keyboard.press('Enter');
  await expect(row.locator('span.truncate').first()).toHaveText(before, { timeout: 10_000 });
});
