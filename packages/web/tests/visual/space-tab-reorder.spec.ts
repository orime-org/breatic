// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a drag does to the strip of Space tabs, in a browser.
 *
 * The gesture itself only exists here. dnd-kit's pointer sensor needs a real
 * pointer sequence past an activation distance, collision detection needs laid
 * out boxes, and auto-scroll needs a viewport that actually overflows — jsdom
 * has none of those, so the unit tests can pin what the pieces compute and
 * nothing about whether a drag works.
 *
 * Whether the order a drag produced survives a reload is in
 * `tests/smoke/space-tab-reorder.spec.ts`; both files take their strip and
 * their two moves from `tests/helpers/tab-strip.ts`.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:visual
 */
import { expect, test } from 'playwright/test';

import { NARROW, WIDE, dragTabOnto, tabOrder } from '../helpers/tab-strip';

test('a dragged tab lands where it was dropped', async ({ page }) => {
  const before = await tabOrder(page);
  expect(before.length).toBeGreaterThanOrEqual(3);
  // The two leftmost, which are on screen however many tabs the strip
  // carries. Dragging the last one works too, and only while it is visible.
  const moved = before[1] as string;
  const anchor = before[0] as string;

  await dragTabOnto(page, moved, anchor);

  const after = await tabOrder(page);
  expect(after[0]).toBe(moved);
  expect(after).toHaveLength(before.length);
  expect([...after].sort()).toEqual([...before].sort());
});

test('a tab still switches Space on Enter rather than starting a drag', async ({
  page,
}) => {
  const ids = await tabOrder(page);
  const target = ids[1] as string;
  const tab = page.getByTestId(`space-tab-${target}`);

  await tab.focus();
  await page.keyboard.press('Enter');

  await expect(tab).toHaveAttribute('aria-selected', 'true');
  expect(await tabOrder(page)).toEqual(ids);
});

test('a drag does not start from the close control', async ({ page }) => {
  // The × sits inside the tab, and the tab is what carries the drag.
  const ids = await tabOrder(page);
  const target = ids[0] as string;
  const close = page.getByTestId(`space-tab-close-${target}`);
  const box = await close.boundingBox();
  if (!box) throw new Error('the close control has no box');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await page.waitForTimeout(500);

  // Either it closed the tab or it did nothing; what it must not do is
  // reorder the strip.
  const after = await tabOrder(page);
  expect(after).toEqual(ids.filter((id) => after.includes(id)));
});

test('the reveal control is disabled while the whole strip fits', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('tabs-reveal-active')).toBeDisabled();
});

test('the reveal control scrolls the current tab into view when it is out of sight', async ({
  page,
}) => {
  const ids = await tabOrder(page);
  // Switch to the first tab, then narrow the window and scroll the strip to
  // its far end so that tab is behind the left arrow.
  await page.getByTestId(`space-tab-${ids[0] as string}`).click();
  await page.setViewportSize(NARROW);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const viewport = document
      .querySelector('[role="tablist"]')
      ?.closest('[data-radix-scroll-area-viewport]');
    if (viewport instanceof HTMLElement) {
      viewport.scrollLeft = viewport.scrollWidth;
      viewport.dispatchEvent(new Event('scroll'));
    }
  });
  await page.waitForTimeout(400);

  const reveal = page.getByTestId('tabs-reveal-active');
  await expect(reveal).toBeEnabled();

  await reveal.click();
  await page.waitForTimeout(800);

  const visible = await page.evaluate((id) => {
    const tab = document.querySelector(`[data-testid="space-tab-${id}"]`);
    const viewport = document
      .querySelector('[role="tablist"]')
      ?.closest('[data-radix-scroll-area-viewport]');
    if (!(tab instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
      return null;
    }
    const t = tab.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    return t.left >= v.left - 1 && t.right <= v.right + 1;
  }, ids[0] as string);

  expect(visible).toBe(true);
  await expect(reveal).toBeDisabled();
});
