// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Project open on a strip of four Space tabs, and the moves made on it.
 *
 * Both halves of the tab-strip suite start here: the cases that measure what a
 * drag does to the strip, and the one that asks whether a reload comes back to
 * the order a drag produced. A spec that wants the strip imports `test` from
 * here; the strip is built by an automatic fixture on that `test`, so every
 * case of every such file gets its own.
 *
 * Each case builds its own strip. The cases used to sit in three serial
 * groups reading what the group before them left, which reports every case
 * after a red one as never run.
 */
import { expect, type Page } from 'playwright/test';

import { test as base } from './slot';
import { openSmokeProject } from './project';
import { createSpace, deleteSpace } from './space';

/**
 * Narrow enough that four tabs must scroll, wide enough that one still fits.
 *
 * The chrome either side of the strip takes about 620px, so at 700 the strip
 * is 78px and a tab at its 160px cap can never be wholly on screen — the
 * reveal control would then be asked for something no scroll position can
 * give. That is a real shape of the window (task #2029) and not this suite's
 * subject.
 */
export const NARROW = { width: 1000, height: 800 };

/**
 * Wide enough that a drag has two boxes to aim at.
 *
 * A tab behind a scroll arrow has none, and the Project opens on its newest
 * Space alone, so the strip starts with exactly one tab however many Spaces
 * the account carries.
 */
export const WIDE = { width: 1440, height: 900 };

/** How many tabs a case wants on the strip. */
const TABS_WANTED = 4;

/**
 * The test a tab-strip case runs under: each case opens the smoke Project on a
 * strip of four tabs it built, and removes the Spaces it made when it ends.
 */
export const test = base.extend<{ tabStrip: void }>({
  tabStrip: [
    async ({ page }, use) => {
      await page.setViewportSize(WIDE);
      await openSmokeProject(page);
      await expect(page.locator('[role="tab"]').first()).toBeVisible({ timeout: 20_000 });
      // Start from a browser that has not been here (#2165), so the strip is the
      // one this case built rather than the one an earlier run left stored.
      await page.evaluate(() => window.localStorage.removeItem('breatic.projectTabs'));
      await page.reload();
      await expect(page.locator('[role="tab"]').first()).toBeVisible({ timeout: 20_000 });
      const mine: string[] = [];
      for (let made = 1; made < TABS_WANTED; made += 1) {
        mine.push(await createSpace(page, 'canvas', `reorder-${Date.now()}-${made}`));
      }
      await use();
      await page.setViewportSize(WIDE);
      while (mine.length > 0) await deleteSpace(page, mine.pop() as string);
    },
    { auto: true },
  ],
});

/**
 * The Space ids on the strip, left to right.
 * @param page - The page to read.
 * @returns Those ids in the order they are painted.
 */
export async function tabOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')]
      .map((t) => t.getAttribute('data-testid') ?? '')
      .map((id) => id.replace('space-tab-', '')),
  );
}

/**
 * Drag one tab onto another and let go.
 *
 * The first move is what carries the press past the sensor's activation
 * distance; the rest walk the pointer over so collision detection sees each
 * tab it passes, the way a hand would.
 * @param page - The page to drive.
 * @param fromId - The Space whose tab is dragged.
 * @param toId - The Space whose tab it is dropped onto.
 * @throws {Error} When either tab has no box to aim at.
 */
export async function dragTabOnto(
  page: Page,
  fromId: string,
  toId: string,
): Promise<void> {
  const from = await page.getByTestId(`space-tab-${fromId}`).boundingBox();
  const to = await page.getByTestId(`space-tab-${toId}`).boundingBox();
  if (!from || !to) throw new Error('a tab in the drag has no box');
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, y, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  // The drop animation, then the broadcast the pending order waits for.
  await page.waitForTimeout(1_000);
}
