// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the drag handle between the two columns leaves behind, measured in a
 * browser.
 *
 * The handle is a 1px line whose hit area is a transparent `::before` reaching
 * 4px to each side, and the panel library decides "is this a handle drag" from
 * a rect it computes on the document — neither of which jsdom has any of. So
 * the question this file answers is one only a real engine can: after a drag,
 * is every element the pointer passed over back in the state it was in.
 */
import { expect, test, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

let page: Page;

/**
 * Sign in and open the account's first project on a canvas space.
 * @param p - The page to drive.
 * @returns Nothing.
 * @throws {Error} When sign-in never reaches a project with a canvas.
 */
async function openProjectWithCanvas(p: Page): Promise<void> {
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
  await expect(p.locator('[data-separator]').first()).toBeVisible({ timeout: 20_000 });
  await expect(p.locator('.react-flow__pane').first()).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await openProjectWithCanvas(page);
});

test.afterAll(async () => {
  await page.close();
});

/**
 * Press `offset` px from the handle's left edge, drag right, release, then move
 * over the canvas with no button held.
 * @param offset - Where to press, relative to the handle's left edge.
 * @returns Nothing.
 */
async function dragHandleThenHoverCanvas(offset: number): Promise<void> {
  const handle = await page.locator('[data-separator]').first().boundingBox();
  if (!handle) throw new Error('the resize handle has no box');
  const x = handle.x + offset;
  const y = handle.y + handle.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) await page.mouse.move(x + step * 20, y);
  await page.mouse.up();

  const pane = await page.locator('.react-flow__pane').first().boundingBox();
  if (!pane) throw new Error('the canvas pane has no box');
  await page.mouse.move(pane.x + 200, pane.y + 200);
  await page.mouse.move(pane.x + 320, pane.y + 300);
  await page.waitForTimeout(150);
}

// The handle's hit area reaches to both sides of the line it draws, and the
// library answers a drag anywhere in it. Pressing on the right-hand half used
// to land on the canvas in the DOM — the canvas began a box selection, the
// library took the pointer capture away, and its `pointerup` never arrived, so
// the canvas went on drawing a selection box under a pointer with no button
// held. Both sides are pressed here because the two halves sit on different
// neighbours: the Agent column on the left, the canvas on the right.
for (const [side, offset] of [
  ['left of the line', -3],
  ['on the line', 0],
  ['right of the line', 3],
] as const) {
  test(`dragging from ${side} leaves the canvas with nothing selected`, async () => {
    const widthBefore = await page
      .locator('[data-testid="agent-column-panel"]')
      .evaluate((el) => el.getBoundingClientRect().width);

    await dragHandleThenHoverCanvas(offset);

    // The drag itself has to have happened — a handle that stopped answering
    // would pass the selection check for the wrong reason.
    const widthAfter = await page
      .locator('[data-testid="agent-column-panel"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(widthAfter).toBeGreaterThan(widthBefore);

    // The box itself, not the pane's class: `react-flow__pane selection` is on
    // the pane from the moment the canvas mounts (measured on a page nobody
    // has touched), because the canvas is configured to select on drag. Only
    // the box element says a selection is being drawn right now.
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);

    // Put the column back for the next case.
    await page.evaluate(() => window.localStorage.removeItem('breatic.agentColumnWidth'));
    await page.reload();
    await expect(page.locator('[data-separator]').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.react-flow__pane').first()).toBeVisible({ timeout: 20_000 });
  });
}
