// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body scrolls while something is dragged near or past its edge, and the
 * drag preview is the dragged content scaled to a 512px longest side
 * (inner#1350).
 *
 * The half jsdom cannot reach: real layout decides where the edges are, real
 * drag events feed the session, and the browser takes the preview. Leaving
 * the window during a drag is not reachable here: an automated drag sends no
 * events outside the viewport. That case is checked by hand.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

const SCROLLER = '[data-testid="document-space"] .doc-body-scroller [data-radix-scroll-area-viewport]';
const TOP = `${EDITOR} > .bn-block-group > .bn-block-outer > .bn-block > .bn-block-content`;

let page: Page;
let errors: string[];
const createdSpaceIds: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Every element handed to setDragImage, measured as it is handed over.
  await page.addInitScript(() => {
    const original = DataTransfer.prototype.setDragImage;
    (window as unknown as { __images: Array<{ width: number; height: number; scale: string }> }).__images = [];
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      const root = el as HTMLElement;
      (window as unknown as { __images: Array<{ width: number; height: number; scale: string }> }).__images.push({
        width: parseFloat(root.style.width),
        height: parseFloat(root.style.height),
        scale: (root.firstElementChild as HTMLElement | null)?.style.transform ?? '',
      });
      original.call(this, el, x, y);
    };
  });
});

test.afterEach(async () => {
  // A case that failed mid-drag still holds the button; the drawer that
  // deletes its Space cannot open under a running drag.
  await page.mouse.up();
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
  expect(errors).toEqual([]);
});

/**
 * Opens a fresh Document Space holding enough lines to scroll.
 * @param p - The page.
 * @param lines - How many lines.
 */
async function openLongDocument(p: Page, lines = 60): Promise<void> {
  await openSmokeProject(p);
  createdSpaceIds.push(await createSpace(p, 'document', `autoscroll-${Date.now()}`));
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  for (let i = 0; i < lines; i += 1) {
    await p.keyboard.type(`line ${i + 1} of a body long enough to scroll`);
    await p.keyboard.press('Enter');
  }
}

/**
 * The body scroller's position.
 * @param p - The page.
 * @returns Its scrollTop.
 */
async function scrollTop(p: Page): Promise<number> {
  return p.locator(SCROLLER).first().evaluate((el) => el.scrollTop);
}

/**
 * Sets the body scroller's position.
 * @param p - The page.
 * @param top - The scrollTop.
 */
async function setScrollTop(p: Page, top: number): Promise<void> {
  await p.locator(SCROLLER).first().evaluate((el, value) => {
    el.scrollTop = value;
  }, top);
  await p.waitForTimeout(100);
}

/**
 * Presses a row's grip and starts dragging it.
 * @param p - The page.
 * @param index - Which visible top-level row.
 * @throws {Error} When the row or its grip has no box.
 */
async function liftRow(p: Page, index: number): Promise<void> {
  await p.mouse.move(5, 5);
  const rows = p.locator(TOP);
  const visible = await rows.evaluateAll((els) => {
    const view = document.querySelector('[data-testid="document-space"] .doc-body-scroller [data-radix-scroll-area-viewport]')!.getBoundingClientRect();
    return els.findIndex((el) => el.getBoundingClientRect().top > view.top + 200);
  });
  const box = await rows.nth(visible + index).boundingBox();
  if (box === null) throw new Error('row has no box');
  await p.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 3 });
  const grip = await p.getByTestId('doc-block-handle').boundingBox();
  if (grip === null) throw new Error('grip has no box');
  await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await p.mouse.down();
  await p.mouse.move(grip.x + 8, grip.y + 12, { steps: 4 });
}

/**
 * Holds the pointer at a point for a while, nudging it so drag events keep coming.
 * @param p - The page.
 * @param x - Across.
 * @param y - Down.
 * @param ms - How long.
 */
async function hold(p: Page, x: number, y: number, ms = 1500): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    await p.mouse.move(x, y + ((t / 100) % 2), { steps: 1 });
    await p.waitForTimeout(100);
  }
}

test('A1 and A2: a row dragged to the body bottom scrolls it down, under a 512px preview', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 0);
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  await liftRow(page, 0);
  const before = await scrollTop(page);
  await hold(page, view.x + 200, view.y + view.height - 10);
  expect(await scrollTop(page)).toBeGreaterThan(before + 300);
  await page.mouse.move(view.x + 200, view.y + view.height / 2, { steps: 4 });
  await page.mouse.up();
  const images = await page.evaluate(() => (window as unknown as { __images: Array<{ width: number; height: number; scale: string }> }).__images);
  const ours = images.at(-1)!;
  expect(Math.max(ours.width, ours.height)).toBeCloseTo(512, 0);
  expect(ours.scale).toMatch(/^scale\(/);
});

test('A3 and A4: a row dragged over the top bar scrolls the body up, and the scrolling stops on release', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 100_000);
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  await liftRow(page, 0);
  const before = await scrollTop(page);
  await hold(page, view.x + 200, view.y - 30);
  const during = await scrollTop(page);
  expect(during).toBeLessThan(before - 300);
  await page.mouse.move(view.x + 200, view.y + view.height / 2, { steps: 4 });
  await page.mouse.up();
  const released = await scrollTop(page);
  await page.waitForTimeout(500);
  expect(await scrollTop(page)).toBe(released);
});

test('§3: the pointer over the Agent column beside the body does not scroll it', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 0);
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  expect(view.x).toBeGreaterThan(100);
  await liftRow(page, 0);
  const before = await scrollTop(page);
  await hold(page, view.x - 60, view.y + view.height - 10);
  expect(await scrollTop(page)).toBe(before);
  await page.mouse.move(view.x + 200, view.y + view.height / 2, { steps: 4 });
  await page.mouse.up();
});

test('A6: a selection pulled from the gutter past the body bottom scrolls it', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 0);
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  const row = (await page.locator(TOP).nth(3).boundingBox())!;
  await page.mouse.move(view.x + 20, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(view.x + 20, row.y + row.height / 2 + 40, { steps: 4 });
  const before = await scrollTop(page);
  await hold(page, view.x + 200, view.y + view.height + 30);
  expect(await scrollTop(page)).toBeGreaterThan(before + 300);
  await page.mouse.up();
});

/**
 * Inserts a table under the first line, off its handle's menu and the grid,
 * and fills its first row.
 * @param p - The page.
 * @param cols - How many columns.
 * @throws {Error} When the first row has no box.
 */
async function insertWideTable(p: Page, cols: number): Promise<void> {
  await p.mouse.move(5, 5);
  const box = await p.locator(TOP).first().boundingBox();
  if (box === null) throw new Error('row 0 has no box');
  await p.mouse.move(box.x + 40, box.y + Math.min(box.height / 2, 12), { steps: 3 });
  await p.getByTestId('doc-block-handle').click();
  await p.getByTestId('doc-block-row-insertBelow').hover();
  await p.getByTestId('doc-block-insert-table').hover();
  await p.getByTestId(`doc-table-size-2-${cols}`).click();
  await expect(p.locator(`${EDITOR} table`)).toHaveCount(1);
  for (let i = 0; i < cols; i += 1) {
    if (i > 0) await p.keyboard.press('Tab');
    await p.keyboard.type(`c${i + 1}`);
  }
}

test('A7 and A1: a column dragged past the table frame scrolls the frame sideways, not the body, under a 512px preview', async () => {
  await openSmokeProject(page);
  createdSpaceIds.push(await createSpace(page, 'document', `autoscroll-${Date.now()}`));
  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('lead');
  await insertWideTable(page, 9);
  const frame = page.locator(`${EDITOR} [data-radix-scroll-area-viewport]`).first();
  const box = (await frame.boundingBox())!;
  const cell = page.locator(`${EDITOR} td`).filter({ hasText: /^c1$/ }).first();
  // The caret out of the table, as the table smoke does before hovering a
  // cell, and the frame back at its start, where typing the row left it at the end.
  await page.locator(TOP).first().click();
  await frame.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await page.waitForTimeout(100);
  const c1 = (await cell.boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2, { steps: 4 });
  const handle = (await page.getByTestId('doc-table-col-handle').boundingBox())!;
  // From the handle's top half, which sits above the frame.
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 8, handle.y + 2, { steps: 4 });
  const left = await frame.evaluate((el) => el.scrollLeft);
  const top = await scrollTop(page);
  await hold(page, box.x + box.width + 30, handle.y + 2);
  expect(await frame.evaluate((el) => el.scrollLeft)).toBeGreaterThan(left + 100);
  expect(await scrollTop(page)).toBe(top);
  await page.mouse.move(box.x + box.width / 2, c1.y + c1.height / 2, { steps: 4 });
  await page.mouse.up();
  const images = await page.evaluate(() => (window as unknown as { __images: Array<{ width: number; height: number; scale: string }> }).__images);
  const ours = images.at(-1)!;
  expect(Math.max(ours.width, ours.height)).toBeCloseTo(512, 0);
});
