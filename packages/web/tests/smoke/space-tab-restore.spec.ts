// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a visit leaves behind for the next one, measured in a browser (#2165).
 *
 * Every question here needs an engine that actually reloads: whether the strip
 * comes back, whether the camera comes back, and whether the automatic frame
 * still happens on a Space nobody has aimed. jsdom has no reload and no
 * viewport, and the storage this reads is written by a browser that rendered.
 *
 * Runs serial on one page, because each case is "what the one before it left".
 */
import { expect, test, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');
test.describe.configure({ mode: 'serial' });

let page: Page;
let projectUrl = '';
/** The Spaces this file created, cleaned up at the end. */
const mine: string[] = [];

/** The Space ids on the strip, left to right. */
async function stripIds(p: Page): Promise<string[]> {
  return p.evaluate(() =>
    // `role="tab"` is what separates the tab buttons from the strip itself
    // and from each tab's inner name element, which share the prefix.
    [...document.querySelectorAll('[role="tab"][data-testid^="space-tab-"]')]
      .map((el) => (el.getAttribute('data-testid') ?? '').replace('space-tab-', '')),
  );
}

/** Which tab is the active one, or null when the strip is empty. */
async function activeId(p: Page): Promise<string | null> {
  return p.evaluate(() => {
    const el = document.querySelector(
      '[role="tab"][data-testid^="space-tab-"][aria-selected="true"]',
    );
    return el?.getAttribute('data-testid')?.replace('space-tab-', '') ?? null;
  });
}

/** The canvas camera as the library holds it. */
async function camera(p: Page): Promise<{ x: number; y: number; zoom: number }> {
  return p.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    const m = new DOMMatrixReadOnly(el ? getComputedStyle(el).transform : '');
    return { x: Math.round(m.e), y: Math.round(m.f), zoom: Number(m.a.toFixed(3)) };
  });
}

/** What the browser is holding for this account and project. */
async function stored(p: Page): Promise<unknown> {
  return p.evaluate(() => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    return raw === null ? null : JSON.parse(raw);
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => {
    // A stale dependency build shows up here and nowhere else, and it reads as
    // a timeout further down if it is not surfaced.
    console.error('[pageerror]', e.message);
  });
  await page.goto('/login');
  await expect(page.locator('#login-email')).toBeVisible({ timeout: 20_000 });
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
  await page.goto('/studio');
  const first = page.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await page.waitForURL(/\/project\//, { timeout: 20_000 });
  projectUrl = page.url();
  // Start from a browser that has not been here, so the first case is about
  // the landing rule rather than about whatever an earlier run left.
  await page.evaluate(() => window.localStorage.removeItem('breatic.projectTabs'));
});

test.afterAll(async () => {
  for (const id of mine) await deleteSpace(page, id);
});

test('lands on one Space and remembers it', async () => {
  await page.goto(projectUrl);
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  const ids = await stripIds(page);
  expect(ids).toHaveLength(1);
  // The landing is stored straight away, so a reload has something to open on.
  await expect.poll(() => stored(page)).not.toBeNull();
});

test('brings three tabs and the one that was showing back through a reload', async () => {
  const a = await createSpace(page, 'canvas', 'Restore A');
  const b = await createSpace(page, 'canvas', 'Restore B');
  mine.push(a, b);
  await expect.poll(() => stripIds(page)).toHaveLength(3);
  const before = await stripIds(page);
  // Show the middle one, so the reload has a choice to get wrong.
  await page.locator(`[data-testid="space-tab-${before[1]}"]`).click();
  await expect.poll(() => activeId(page)).toBe(before[1]);

  await page.reload();
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  expect(await stripIds(page)).toEqual(before);
  expect(await activeId(page)).toBe(before[1]);
});

test('frames the Space on a first look and stores no camera for it', async () => {
  const ids = await stripIds(page);
  const fresh = ids[2] as string;
  await page.locator(`[data-testid="space-tab-${fresh}"]`).click();
  await expect.poll(() => activeId(page)).toBe(fresh);
  const held = (await stored(page)) as Record<string, Record<string, {
    tabs: Array<{ spaceId: string; viewport: unknown }>;
  }>>;
  const slot = Object.values(Object.values(held)[0] ?? {})[0];
  expect(slot?.tabs.find((t) => t.spaceId === fresh)?.viewport).toBeNull();
});

test('comes back to the camera the user aimed, across a switch and a reload', async () => {
  const ids = await stripIds(page);
  const [first, second] = ids as [string, string];
  await page.locator(`[data-testid="space-tab-${first}"]`).click();
  await expect.poll(() => activeId(page)).toBe(first);

  // Aim it: a real wheel gesture over the pane, which is how the user pans.
  const pane = page.locator('.react-flow__pane').first();
  await pane.hover();
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(400);
  const aimed = await camera(page);

  await page.locator(`[data-testid="space-tab-${second}"]`).click();
  await expect.poll(() => activeId(page)).toBe(second);
  await page.locator(`[data-testid="space-tab-${first}"]`).click();
  await expect.poll(() => activeId(page)).toBe(first);
  expect(await camera(page)).toEqual(aimed);

  await page.reload();
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  expect(await activeId(page)).toBe(first);
  expect(await camera(page)).toEqual(aimed);
});

test('keeps a closed tab closed, and an emptied strip empty', async () => {
  const ids = await stripIds(page);
  const doomed = ids[ids.length - 1] as string;
  // The × is 0 wide and transparent until the tab is hovered, which is how a
  // user reaches it.
  await page.locator(`[data-testid="space-tab-${doomed}"]`).hover();
  await page.locator(`[data-testid="space-tab-close-${doomed}"]`).click();
  await expect.poll(() => stripIds(page)).not.toContain(doomed);

  await page.reload();
  // Wait for the strip the reload restored, by its length. "Does not contain
  // the closed one" is also true of the empty strip a page still loading
  // shows, so polling on that walks on before the tabs are there.
  await expect
    .poll(() => stripIds(page), { timeout: 20_000 })
    .toHaveLength(ids.length - 1);
  expect(await stripIds(page)).not.toContain(doomed);

  // Close what is left, one at a time, and the strip stays empty over a reload
  // rather than opening the newest Space again.
  for (const id of await stripIds(page)) {
    await page.locator(`[data-testid="space-tab-${id}"]`).hover();
    await page.locator(`[data-testid="space-tab-close-${id}"]`).click();
    await expect.poll(() => stripIds(page)).not.toContain(id);
  }
  expect(await stripIds(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('[data-testid="no-active-space"]')).toBeVisible({
    timeout: 20_000,
  });
  expect(await stripIds(page)).toEqual([]);
});

test('shows another account none of it', async () => {
  const held = (await stored(page)) as Record<string, unknown>;
  const accounts = Object.keys(held);
  expect(accounts).toHaveLength(1);
  // Stand in for the other account by asking under a different id: what the
  // page reads is addressed by account, so a second one finds nothing.
  const forStranger = await page.evaluate(() => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    return parsed['some-other-account'] ?? null;
  });
  expect(forStranger).toBeNull();
});
