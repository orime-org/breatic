// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Dragging a Space tab to a new place, in a browser.
 *
 * The gesture itself only exists here. dnd-kit's pointer sensor needs a real
 * pointer sequence past an activation distance, collision detection needs laid
 * out boxes, and auto-scroll needs a viewport that actually overflows — jsdom
 * has none of those, so the unit tests can pin what the pieces compute and
 * nothing about whether a drag works. What is checked here: the tab lands
 * where it was dropped, the new order survives a reload, the keyboard still
 * switches Space rather than starting a drag, and the control that brings the
 * current tab back into view does what it says.
 */
import { expect, test, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

/**
 * Narrow enough that four tabs must scroll, wide enough that one still fits.
 *
 * The chrome either side of the strip takes about 620px, so at 700 the strip
 * is 78px and a tab at its 160px cap can never be wholly on screen — the
 * reveal control would then be asked for something no scroll position can
 * give. That is a real shape of the window (task #2029) and not this spec's
 * subject.
 */
const NARROW = { width: 1000, height: 800 };

/** How many tabs this spec wants on the strip. */
const TABS_WANTED = 4;

let page: Page;
const createdSpaceIds: string[] = [];

/**
 * Sign in and open the account's first project.
 * @param p - The page to drive.
 * @returns Nothing.
 */
async function openProject(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
  await p.goto('/studio');
  const first = p.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await p.waitForURL(/\/project\//, { timeout: 20_000 });
  await expect(p.locator('[role="tab"]').first()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * The Space ids on the strip, left to right.
 * @param p - The page to read.
 * @returns Those ids in the order they are painted.
 */
async function tabOrder(p: Page): Promise<string[]> {
  return p.evaluate(() =>
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
 * @param p - The page to drive.
 * @param fromId - The Space whose tab is dragged.
 * @param toId - The Space whose tab it is dropped onto.
 * @returns Nothing.
 * @throws {Error} When either tab has no box to aim at.
 */
async function dragTabOnto(
  p: Page,
  fromId: string,
  toId: string,
): Promise<void> {
  const from = await p.getByTestId(`space-tab-${fromId}`).boundingBox();
  const to = await p.getByTestId(`space-tab-${toId}`).boundingBox();
  if (!from || !to) throw new Error('a tab in the drag has no box');
  const y = from.y + from.height / 2;
  await p.mouse.move(from.x + from.width / 2, y);
  await p.mouse.down();
  await p.mouse.move(from.x + from.width / 2 + 12, y, { steps: 4 });
  await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await p.mouse.up();
  // The drop animation, then the broadcast the pending order waits for.
  await p.waitForTimeout(1_000);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openProject(page);
  const already = await page.locator('[role="tab"]').count();
  for (let i = already; i < TABS_WANTED; i += 1) {
    createdSpaceIds.push(
      await createSpace(page, 'canvas', `reorder-${Date.now()}-${i}`),
    );
  }
});

test.afterAll(async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page.close();
});

test.describe.serial('a tab dragged to a new place', () => {
  test('lands where it was dropped', async () => {
    const before = await tabOrder(page);
    expect(before.length).toBeGreaterThanOrEqual(3);
    const moved = before[before.length - 1] as string;
    const anchor = before[0] as string;

    await dragTabOnto(page, moved, anchor);

    const after = await tabOrder(page);
    expect(after[0]).toBe(moved);
    expect(after).toHaveLength(before.length);
    expect([...after].sort()).toEqual([...before].sort());
  });

  test('is still there after a reload', async () => {
    const before = await tabOrder(page);

    await page.reload();
    await expect(page.locator('[role="tab"]').first()).toBeVisible({
      timeout: 20_000,
    });
    // The order arrives with the meta document, a moment behind the first tab.
    await expect
      .poll(async () => (await tabOrder(page)).join(','), { timeout: 10_000 })
      .toBe(before.join(','));
  });

  test('still switches Space on Enter rather than starting a drag', async () => {
    const ids = await tabOrder(page);
    const target = ids[1] as string;
    const tab = page.getByTestId(`space-tab-${target}`);

    await tab.focus();
    await page.keyboard.press('Enter');

    await expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await tabOrder(page)).toEqual(ids);
  });

  test('does not start a drag from the close control', async () => {
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
});

test.describe.serial('bringing the current tab back into view', () => {
  test('is disabled while the whole strip fits', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    await expect(page.getByTestId('tabs-reveal-active')).toBeDisabled();
  });

  test('scrolls the current tab into view when it is out of sight', async () => {
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
});
