// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body scrolls while something is dragged near or past its edge, and the
 * drag preview is the dragged content, scaled down to a 512px longest side
 * when it is longer than that
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
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { wavBytes } from '../helpers/media-bytes';
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
    (window as unknown as { __images: Array<{ width: number; height: number; scale: string; lift: number }> }).__images = [];
    DataTransfer.prototype.setDragImage = function (el: Element, x: number, y: number) {
      const root = el as HTMLElement;
      (window as unknown as { __images: Array<{ width: number; height: number; scale: string; lift: number }> }).__images.push({
        width: parseFloat(root.style.width),
        height: parseFloat(root.style.height),
        scale: (root.firstElementChild as HTMLElement | null)?.style.transform ?? '',
        // How far the first block stands below the preview's top edge.
        lift: (root.querySelector('.bn-block-content')?.getBoundingClientRect().top ?? root.getBoundingClientRect().top) -
          root.getBoundingClientRect().top,
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

test('A1 and A2: a row dragged to the body bottom scrolls it down, under a preview no longer than 512px', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 0);
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  await liftRow(page, 0);
  const before = await scrollTop(page);
  await hold(page, view.x + 200, view.y + view.height - 10);
  expect(await scrollTop(page)).toBeGreaterThan(before + 300);
  await page.mouse.move(view.x + 200, view.y + view.height / 2, { steps: 4 });
  await page.mouse.up();
  const images = await page.evaluate(() => (window as unknown as { __images: Array<{ width: number; height: number; scale: string; lift: number }> }).__images);
  const ours = images.at(-1)!;
  // The row is drawn at its own size, scaled down only past 512px (A1).
  const longest = Math.max(ours.width, ours.height);
  expect(longest).toBeGreaterThan(0);
  expect(longest).toBeLessThanOrEqual(512.5);
  if (longest < 511.5) expect(ours.scale).toBe('scale(1)');
  else expect(ours.scale).toMatch(/^scale\(/);
  expect(ours.lift).toBeCloseTo(0, 0);
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

test('A1: an audio dragged by its grip is previewed at the shape it has in the body', async () => {
  await openSmokeProject(page);
  createdSpaceIds.push(await createSpace(page, 'document', `autoscroll-${Date.now()}`));
  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('lead');
  await editor.evaluate((element, base64) => {
    const transfer = new DataTransfer();
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([raw], 'clip.wav', { type: 'audio/wav' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, wavBytes().toString('base64'));
  const box = page.locator(`${EDITOR} [data-content-type="audio"] [data-media-box]`).first();
  await expect(box).toBeVisible({ timeout: 60_000 });
  const drawn = (await box.boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(drawn.x + 10, drawn.y + drawn.height / 2, { steps: 3 });
  const grip = (await page.getByTestId('doc-block-handle').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 8, grip.y + 12, { steps: 4 });
  await page.mouse.move(grip.x + 20, grip.y + 40, { steps: 4 });
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 4 });
  await page.mouse.up();
  const images = await page.evaluate(() => (window as unknown as { __images: Array<{ width: number; height: number; scale: string; lift: number }> }).__images);
  const ours = images.at(-1)!;
  expect(Math.max(ours.width, ours.height)).toBeCloseTo(512, 0);
  expect(ours.width / ours.height).toBeCloseTo(drawn.width / drawn.height, 1);
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

test('A7 and A1: a column dragged past the table frame scrolls the frame sideways, not the body, under a preview at the column\'s own size', async () => {
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
  await hold(page, box.x + box.width / 2, c1.y + c1.height / 2, 400);
  // Over the table, only the table's own line says where the column lands
  // (inner#1404).
  await expect(page.locator('.prosemirror-dropcursor-block, .prosemirror-dropcursor-inline')).toHaveCount(0);
  await page.mouse.up();
  const images = await page.evaluate(() => (window as unknown as { __images: Array<{ width: number; height: number; scale: string; lift: number }> }).__images);
  const ours = images.at(-1)!;
  // A column is shorter than 512 on both sides: it is shown at its own size.
  expect(ours.scale).toBe('scale(1)');
  expect(Math.max(ours.width, ours.height)).toBeLessThan(512);
  // Its first block stands where it stands in the cell: under the cell's own
  // top line and padding, with no space of its own above it.
  const inset = await cell.evaluate((td) => {
    const style = getComputedStyle(td);
    return parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth);
  });
  expect(ours.lift).toBeCloseTo(inset, 0);
});

test('A4 and A7: a column released in the gutter past the table frame lands at the nearest end', async () => {
  await openSmokeProject(page);
  createdSpaceIds.push(await createSpace(page, 'document', `autoscroll-${Date.now()}`));
  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('lead');
  await insertWideTable(page, 3);
  await page.locator(TOP).first().click();
  const frame = (await page.locator(`${EDITOR} [data-radix-scroll-area-viewport]`).first().boundingBox())!;
  const c1 = (await page.locator(`${EDITOR} td`).filter({ hasText: /^c1$/ }).first().boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2, { steps: 4 });
  const handle = (await page.getByTestId('doc-table-col-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 8, handle.y + 2, { steps: 4 });
  // Past the frame's right edge, in the gutter beside the text column.
  await hold(page, frame.x + frame.width + 40, c1.y + c1.height / 2, 400);
  await page.mouse.up();
  const first = await page.locator(`${EDITOR} tr`).first().locator('td, th').allTextContents();
  expect(first).toEqual(['c2', 'c3', 'c1']);
});

test('A7: a column dragged along the body\'s top edge leaves the body where it is', async () => {
  await openLongDocument(page, 30);
  await page.keyboard.type('anchor');
  const anchor = page.locator(TOP).filter({ hasText: 'anchor' }).first();
  const ab = (await anchor.boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(ab.x + 40, ab.y + Math.min(ab.height / 2, 12), { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-3-4').click();
  await page.keyboard.type('x1');
  for (let i = 0; i < 40; i += 1) {
    await page.locator(TOP).last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(`line ${i + 1} below the table`);
  }
  // The table's top line, where the column handle sits, 10px under the
  // body's top edge: inside the band the browser's own drag autoscroll reads.
  const scroller = page.locator(SCROLLER).first();
  const view = (await scroller.boundingBox())!;
  const tableTop = (await page.locator(`${EDITOR} table`).first().boundingBox())!;
  await scroller.evaluate((el, delta) => {
    el.scrollTop += delta;
  }, tableTop.y - view.y - 10);
  await page.waitForTimeout(200);
  const cell = (await page.locator(`${EDITOR} td`).filter({ hasText: 'x1' }).first().boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(cell.x + 10, cell.y + 10, { steps: 4 });
  const handle = (await page.getByTestId('doc-table-col-handle').boundingBox())!;
  expect(handle.y + 2 - view.y).toBeLessThan(20);
  const before = await scrollTop(page);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 8, handle.y + 2, { steps: 4 });
  await hold(page, handle.x + handle.width / 2 + 60, handle.y + 2, 1500);
  expect(await scrollTop(page)).toBe(before);
  await page.mouse.up();
});

/**
 * A top-level row by the start of its text.
 * @param p - The page.
 * @param text - How its text starts.
 * @returns The row's box.
 * @throws {Error} When the row has no box.
 */
async function rowBox(p: Page, text: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await p.locator(TOP).filter({ hasText: new RegExp(`^${text}`) }).first().boundingBox();
  if (box === null) throw new Error(`row "${text}" has no box`);
  return box;
}

/**
 * The body's lines, top to bottom.
 * @param p - The page.
 * @returns Each top-level row's text.
 */
async function lines(p: Page): Promise<string[]> {
  return p.locator(TOP).allTextContents();
}

for (const press of ['text', 'gutter', 'shift on text'] as const) {
  for (const way of ['down', 'up'] as const) {
    test(`A6: a selection pulled from ${press} ${way} past the body edge scrolls it that way`, async () => {
      await openLongDocument(page);
      const view = (await page.locator(SCROLLER).first().boundingBox())!;
      await setScrollTop(page, way === 'down' ? 0 : 100_000);
      // A press on a row well inside the window, far from the edge it is pulled to.
      const rows = page.locator(TOP);
      const pick = await rows.evaluateAll((els, downward) => {
        const box = document.querySelector('[data-testid="document-space"] .doc-body-scroller [data-radix-scroll-area-viewport]')!.getBoundingClientRect();
        const inside = els.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top > box.top + 150 && r.bottom < box.bottom - 150;
        });
        const el = downward ? inside[0] : inside[inside.length - 1];
        const r = el!.getBoundingClientRect();
        return { y: r.top + r.height / 2, x: r.left };
      }, way === 'down');
      const x = press === 'gutter' ? view.x + 20 : pick.x + 30;
      if (press === 'shift on text') {
        await page.mouse.click(pick.x + 5, pick.y);
        await page.keyboard.down('Shift');
      }
      await page.mouse.move(x, pick.y);
      await page.mouse.down();
      await page.mouse.move(x, pick.y + (way === 'down' ? 40 : -40), { steps: 4 });
      const before = await scrollTop(page);
      await hold(page, view.x + 200, way === 'down' ? view.y + view.height + 30 : view.y - 30);
      const after = await scrollTop(page);
      await page.mouse.up();
      if (press === 'shift on text') await page.keyboard.up('Shift');
      if (way === 'down') expect(after).toBeGreaterThan(before + 300);
      else expect(after).toBeLessThan(before - 300);
    });
  }
}

test('§5: a drag whose dragstart was cancelled does not scroll the body', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 0);
  await page.evaluate(() => {
    document.addEventListener('dragstart', (event) => event.preventDefault(), true);
  });
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  await liftRow(page, 0);
  const before = await scrollTop(page);
  await hold(page, view.x + 200, view.y + view.height - 10);
  expect(await scrollTop(page)).toBe(before);
  await page.mouse.up();
});

test('A4: Escape ends the scrolling, also after the body has scrolled', async () => {
  await openLongDocument(page);
  await setScrollTop(page, 0);
  const view = (await page.locator(SCROLLER).first().boundingBox())!;
  await liftRow(page, 0);
  await hold(page, view.x + 200, view.y + view.height - 10, 800);
  expect(await scrollTop(page)).toBeGreaterThan(100);
  await page.keyboard.press('Escape');
  const stopped = await scrollTop(page);
  await hold(page, view.x + 200, view.y + view.height - 10, 800);
  expect(await scrollTop(page)).toBe(stopped);
  await page.mouse.up();
});

/**
 * The two rows the drop line is drawn between.
 * @param p - The page.
 * @returns The texts of the row above and the row below it.
 * @throws {Error} When no drop line is drawn.
 */
async function dropLineBetween(p: Page): Promise<[string, string]> {
  return p.evaluate((top) => {
    const line = document.querySelector('.prosemirror-dropcursor-block');
    if (line === null) throw new Error('no drop line');
    const r = line.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const rows = [...document.querySelectorAll(top)].map((el) => ({ text: el.textContent ?? '', box: el.getBoundingClientRect() }));
    const above = rows.filter((row) => row.box.bottom <= mid + 2).pop()?.text ?? '';
    const below = rows.find((row) => row.box.top >= mid - 2)?.text ?? '';
    return [above, below] as [string, string];
  }, TOP);
}

/**
 * Lifts a row by its grip.
 * @param p - The page.
 * @param text - How the row's text starts.
 * @throws {Error} When the row or its grip has no box.
 */
async function liftRowByText(p: Page, text: string): Promise<void> {
  const row = await rowBox(p, text);
  await p.mouse.move(5, 5);
  await p.mouse.move(row.x + 40, row.y + row.height / 2, { steps: 3 });
  const grip = await p.getByTestId('doc-block-handle').boundingBox();
  if (grip === null) throw new Error('grip has no box');
  await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await p.mouse.down();
  await p.mouse.move(grip.x + 8, grip.y + 12, { steps: 4 });
}

for (const where of ['over the text', 'in the gutter left of the column'] as const) {
  test(`A4 and §4: a row released ${where} lands where the drop line was drawn, and is kept`, async () => {
    await openLongDocument(page, 12);
    await setScrollTop(page, 0);
    const view = (await page.locator(SCROLLER).first().boundingBox())!;
    await liftRowByText(page, 'line 3 of');
    const target = await rowBox(page, 'line 8 of');
    await hold(page, where === 'over the text' ? target.x + 100 : view.x + 20, target.y + target.height * 0.75, 400);
    const [above, below] = await dropLineBetween(page);
    await page.mouse.up();
    const after = await lines(page);
    expect(after.filter((line) => line.startsWith('line 3 of'))).toHaveLength(1);
    const at = after.findIndex((line) => line.startsWith('line 3 of'));
    expect([after[at - 1], after[at + 1]]).toEqual([above, below]);
  });
}

test('A9: a table row in flight shows no drop cursor, a block in flight does', async () => {
  await openSmokeProject(page);
  createdSpaceIds.push(await createSpace(page, 'document', `autoscroll-${Date.now()}`));
  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.type('lead');
  await insertWideTable(page, 3);
  await page.locator(TOP).first().click();
  await page.keyboard.press('End');
  const cell = (await page.locator(`${EDITOR} td`).filter({ hasText: /^c1$/ }).first().boundingBox())!;
  await page.mouse.move(5, 5);
  await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 4 });
  const handle = (await page.getByTestId('doc-table-row-handle').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 8, { steps: 4 });
  await hold(page, cell.x + cell.width / 2, cell.y + cell.height + 10, 400);
  await expect(page.locator('.prosemirror-dropcursor-block, .prosemirror-dropcursor-inline')).toHaveCount(0);
  await page.mouse.up();

  const lead = await rowBox(page, 'lead');
  await page.mouse.move(5, 5);
  await page.mouse.move(lead.x + 40, lead.y + lead.height / 2, { steps: 3 });
  const grip = (await page.getByTestId('doc-block-handle').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 8, grip.y + 12, { steps: 4 });
  const table = (await page.locator(`${EDITOR} table`).first().boundingBox())!;
  await hold(page, table.x + 100, table.y + table.height + 20, 400);
  await expect(page.locator('.prosemirror-dropcursor-block, .prosemirror-dropcursor-inline')).not.toHaveCount(0);
  await page.mouse.up();
});
