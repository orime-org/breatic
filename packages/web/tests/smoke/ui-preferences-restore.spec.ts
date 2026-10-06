// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Interface preferences a reader adjusts come back after a reload and belong
 * to the account that set them, measured in a browser.
 *
 * The questions need a real reload: whether the Agent column ever mounts
 * before it is hidden again, whether the theme on the first frame is the one
 * picked, and what the browser is actually holding afterwards.
 *
 *   pnpm --filter @breatic/web exec playwright test --project=smoke ui-preferences-restore
 */
import { expect, test, type Page } from 'playwright/test';

import { credentialsFor } from '../helpers/credentials';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { signIn, signOut } from '../helpers/session';
import { visibleSpace } from '../helpers/space';

const AGENT_COLUMN = '[data-testid="agent-column"]';
const AGENT_PANEL = '[data-testid="agent-column-panel"]';

/**
 * Open one of account A's projects and wait for the canvas.
 * @param page - The page to open it in.
 * @param index - Which of A's projects.
 */
async function openProject(page: Page, index = 0): Promise<void> {
  await openSmokeProject(page, 'A', index);
  await expect(visibleSpace(page).locator('.react-flow__pane')).toBeVisible({ timeout: 30_000 });
}

/**
 * Reload and wait for the canvas.
 * @param page - The page to reload.
 */
async function reloadProject(page: Page): Promise<void> {
  await page.reload();
  await expect(visibleSpace(page).locator('.react-flow__pane')).toBeVisible({ timeout: 30_000 });
}

/**
 * Record, from before any page script runs, whether the Agent column is ever
 * attached to the document and which theme the root carries first.
 * @param page - The page to watch.
 */
async function watchFirstFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __agentSeen: boolean; __firstTheme: string | null };
    w.__agentSeen = false;
    w.__firstTheme = null;
    new MutationObserver(() => {
      if (w.__firstTheme === null && document.documentElement.dataset.theme !== undefined) {
        w.__firstTheme = document.documentElement.dataset.theme;
      }
      if (document.querySelector('[data-testid="agent-column"]') !== null) w.__agentSeen = true;
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

/**
 * Everything the browser holds in localStorage.
 * @param page - The page to read.
 * @returns Key to raw value.
 */
async function storage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key !== null) out[key] = window.localStorage.getItem(key) ?? '';
    }
    return out;
  });
}

/**
 * The toolbar toggle for the minimap or snap.
 * @param page - The project page.
 * @param name - `Minimap` or `Snap to grid`, matched against the button name.
 * @returns The button.
 */
function toggle(page: Page, name: RegExp): ReturnType<Page['locator']> {
  return page.getByTestId('viewport-toolbar').getByRole('button', { name });
}

test('a hidden Agent panel stays hidden through a reload and never mounts first', async ({ page }) => {
  await openProject(page);
  await expect(page.locator(AGENT_COLUMN)).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('agent-toggle').click();
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);

  await watchFirstFrames(page);
  await reloadProject(page);
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __agentSeen: boolean }).__agentSeen)).toBe(false);

  // The other project keeps its own state: never toggled there, so open.
  await openProject(page, 1);
  await expect(page.locator(AGENT_COLUMN)).toBeVisible({ timeout: 20_000 });

  // Back on the first one it is still hidden, and showing it is remembered too.
  await openProject(page, 0);
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);
  await page.getByTestId('agent-toggle').click();
  await expect(page.locator(AGENT_COLUMN)).toBeVisible();
  await reloadProject(page);
  await expect(page.locator(AGENT_COLUMN)).toBeVisible({ timeout: 20_000 });
});

test('the Agent column width, minimap and snap come back after a reload', async ({ page }) => {
  await openProject(page);
  const panel = page.locator(AGENT_PANEL);
  await expect(panel).toBeVisible({ timeout: 20_000 });

  const handle = await page.locator('[data-separator]').first().boundingBox();
  if (!handle) throw new Error('the resize handle has no box');
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) await page.mouse.move(handle.x + step * 20, y);
  await page.mouse.up();
  const dragged = await panel.evaluate((el) => el.getBoundingClientRect().width);

  await toggle(page, /minimap/i).click();
  await toggle(page, /snap to grid/i).click();
  await expect(toggle(page, /minimap/i)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page, /snap to grid/i)).toHaveAttribute('aria-pressed', 'true');

  await reloadProject(page);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const restored = await panel.evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.abs(restored - dragged)).toBeLessThanOrEqual(2);
  await expect(toggle(page, /minimap/i)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page, /snap to grid/i)).toHaveAttribute('aria-pressed', 'true');
  await expect(visibleSpace(page).locator('.react-flow__minimap')).toHaveCount(0);
});

test('a folded Studio rail section stays folded after a reload', async ({ page }) => {
  await page.goto('/studio');
  const heading = page.getByRole('button', { name: 'Personal Studio' });
  await expect(heading).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 });

  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Personal Studio' })).toHaveAttribute(
    'aria-expanded',
    'false',
    { timeout: 20_000 },
  );
});

test('the picked theme is on the first frame after a reload, stored as the plain value', async ({ page }) => {
  await page.goto('/studio');
  await page.getByTestId('theme-toggle').click();
  await page.getByTestId('theme-option-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await watchFirstFrames(page);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => (window as unknown as { __firstTheme: string | null }).__firstTheme)).toBe('dark');

  await page.getByTestId('theme-toggle').click();
  await page.getByTestId('theme-option-light').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect((await storage(page))['breatic.theme']).toBe('light');
});

test('the browser holds only the registered keys, with plain values', async ({ page }) => {
  // What an earlier version left behind; the app deletes it at startup.
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('seeded') !== null) return;
    window.sessionStorage.setItem('seeded', '1');
    window.localStorage.setItem('breatic.preferences', '{"state":{"theme":"dark"},"version":1}');
    window.localStorage.setItem('breatic.agentColumnWidth', '500');
    window.localStorage.setItem('breatic.myStudios', '1');
  });
  await openProject(page);
  await page.getByTestId('agent-toggle').click();
  await toggle(page, /snap to grid/i).click();
  await page.goto('/studio');
  await page.getByTestId('theme-toggle').click();
  await page.getByTestId('theme-option-dark').click();
  await page.getByRole('button', { name: 'Personal Studio' }).click();

  const held = await storage(page);
  const allowed = ['breatic.locale', 'breatic.theme', 'breatic.projectTabs', 'breatic.userPreferences', 'breatic.sessionSeen'];
  expect(Object.keys(held).filter((key) => !allowed.includes(key))).toEqual([]);
  expect(held['breatic.theme']).toBe('dark');

  const userId = Object.keys(JSON.parse(held['breatic.userPreferences'] ?? '{}') as object)[0] ?? '';
  const prefs = JSON.parse(held['breatic.userPreferences'] ?? '{}') as Record<string, Record<string, unknown>>;
  expect(prefs[userId]).toMatchObject({
    snapToGrid: true,
    railCollapsed: { personal: true, mine: false, joined: false },
  });
  const tabs = JSON.parse(held['breatic.projectTabs'] ?? '{}') as Record<string, Record<string, Record<string, unknown>>>;
  expect(tabs[userId]?.[smokeProjectId('A', 0)]?.agentPanelOpen).toBe(false);
  for (const value of Object.values(held)) expect(value).not.toContain('"version"');
});

test('another account in the same browser gets its own preferences', async ({ page }) => {
  // The page opens with A's session from setup, which every other case
  // shares, so it is left alone: dropping the cookie reaches the login form
  // without revoking it. The way back from B to A goes through the real sign
  // out, where the page is not reloaded and the stores still hold B's values.
  const first = credentialsFor('A');
  const second = credentialsFor('B');
  await openProject(page);
  await page.getByTestId('agent-toggle').click();
  await toggle(page, /minimap/i).click();
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Personal Studio' }).click();

  await page.context().clearCookies();
  await signIn(page, second.email, second.password);
  await expect(page.getByRole('button', { name: 'Personal Studio' })).toHaveAttribute(
    'aria-expanded',
    'true',
    { timeout: 20_000 },
  );
  await openSmokeProject(page, 'B');
  await expect(visibleSpace(page).locator('.react-flow__pane')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(AGENT_COLUMN)).toBeVisible({ timeout: 20_000 });
  await expect(toggle(page, /minimap/i)).toHaveAttribute('aria-pressed', 'true');

  await signOut(page);
  await signIn(page, first.email, first.password);
  await expect(page.getByRole('button', { name: 'Personal Studio' })).toHaveAttribute(
    'aria-expanded',
    'false',
    { timeout: 20_000 },
  );
  await openProject(page);
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);
  await expect(toggle(page, /minimap/i)).toHaveAttribute('aria-pressed', 'false');
});

test('a browser that refuses to store still lets the reader toggle everything', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = (): void => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await openProject(page);
  await expect(page.locator(AGENT_COLUMN)).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('agent-toggle').click();
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);
  await toggle(page, /minimap/i).click();
  await expect(toggle(page, /minimap/i)).toHaveAttribute('aria-pressed', 'false');

  await page.goto('/studio');
  const heading = page.getByRole('button', { name: 'Personal Studio' });
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
});
