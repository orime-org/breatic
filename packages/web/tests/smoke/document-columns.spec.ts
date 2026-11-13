// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314: blocks dragged beside each other stand in columns.
 *
 * Every case drives the browser's own HTML5 drag with the mouse (a press on
 * the handle, a small move, a move onto the target), which is the path a
 * user's drag takes through BlockNote's drop cursor and ProseMirror's drop.
 */

import { expect, type Page } from 'playwright/test';

import { test } from '../helpers/slot';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

let page: Page;
let errors: string[];
const createdSpaceIds: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
});

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
  expect(errors).toEqual([]);
});

/**
 * Open a freshly made Document Space holding these lines.
 * @param p - The page.
 * @param lines - The lines, typed one per row.
 */
async function openWithLines(p: Page, lines: readonly string[]): Promise<void> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `columns-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) await p.keyboard.press('Enter');
    await p.keyboard.type(line);
  }
}

/**
 * The row whose words are these.
 * @param p - The page.
 * @param words - The words.
 * @returns Its content box.
 */
function row(p: Page, words: string): ReturnType<Page['locator']> {
  return p.locator(`${EDITOR} .bn-block-content`, { hasText: new RegExp(`^${words}$`) });
}

/**
 * Drag a row by its handle to a point, with the browser's own drag.
 * @param p - The page.
 * @param words - The dragged row's words.
 * @param to - Where to release.
 * @param to.x - The x.
 * @param to.y - The y.
 * @throws {Error} When the row or its handle has no box.
 */
async function dragRowTo(p: Page, words: string, to: { x: number; y: number }): Promise<void> {
  await p.mouse.move(5, 5);
  const box = await row(p, words).boundingBox();
  if (box === null) throw new Error(`no row "${words}"`);
  await p.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 3 });
  const handle = p.getByTestId('doc-block-handle');
  await expect(handle).toBeVisible();
  const grip = await handle.boundingBox();
  if (grip === null) throw new Error('no handle');
  await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 3 });
  await p.mouse.down();
  // Far enough for the browser to start the drag before the long move: a
  // drag starting partway through Playwright's stepped move leaves that move
  // waiting (seen with a handle in a column's gap).
  await p.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  await p.mouse.move(to.x, to.y, { steps: 12 });
  await p.mouse.up();
}

/**
 * The words of each column of each group, in reading order.
 * @param p - The page.
 * @returns One array per group, one string per column.
 */
async function groups(p: Page): Promise<string[][]> {
  return p.locator(`${EDITOR} .doc-columns`).evaluateAll((lists) =>
    lists.map((list) =>
      [...list.querySelectorAll(':scope > .doc-columns-row > .doc-column')].map((column) =>
        [...column.querySelectorAll('.bn-inline-content')].map((line) => line.textContent ?? '').join(','),
      ),
    ),
  );
}

test('dragging a row onto the right edge of another stands them in two columns', async () => {
  await openWithLines(page, ['alpha', 'beta', 'gamma']);
  const target = await row(page, 'alpha').boundingBox();
  if (target === null) throw new Error('no alpha');
  await dragRowTo(page, 'gamma', { x: target.x + target.width - 6, y: target.y + target.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'gamma']]);
  const columns = await page.locator(`${EDITOR} .doc-column`).evaluateAll((list) =>
    list.map((column) => column.getBoundingClientRect().left),
  );
  expect(columns[1]! - columns[0]!).toBeGreaterThan(200);
});

test('dragging a row into the empty space right of a narrow block still lands beside it', async () => {
  await openWithLines(page, ['alpha', 'beta']);
  const target = await row(page, 'alpha').boundingBox();
  if (target === null) throw new Error('no alpha');
  // Past the body's right edge, in the page margin, level with alpha.
  await dragRowTo(page, 'beta', { x: target.x + target.width + 120, y: target.y + target.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'beta']]);
});

test('a block in the second column has its handle in the gap, and drags from there', async () => {
  await openWithLines(page, ['alpha', 'beta', 'gamma']);
  const a = await row(page, 'alpha').boundingBox();
  if (a === null) throw new Error('no alpha');
  await dragRowTo(page, 'gamma', { x: a.x + a.width - 6, y: a.y + a.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'gamma']]);

  const second = await page.locator(`${EDITOR} .doc-column`).nth(1).boundingBox();
  const g = await row(page, 'gamma').boundingBox();
  if (second === null || g === null) throw new Error('no second column');
  // Coming from the left column across the gap, the pointer reaches the
  // right half of the gap, which is the second column's row.
  await page.mouse.move(second.x - 60, g.y + g.height / 2);
  await page.mouse.move(second.x - 20, g.y + g.height / 2, { steps: 4 });
  const handle = page.getByTestId('doc-block-handle');
  await expect(handle).toBeVisible();
  const grip = await handle.boundingBox();
  if (grip === null) throw new Error('no handle');
  expect(grip.x).toBeGreaterThanOrEqual(second.x - 36 - 1);
  expect(grip.x + grip.width).toBeLessThanOrEqual(second.x - 12 + 1);

  // Dragged from that handle below beta, gamma leaves the columns.
  const b = await row(page, 'beta').boundingBox();
  if (b === null) throw new Error('no beta');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  await page.mouse.move(b.x + 40, b.y + b.height - 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => groups(page)).toEqual([]);
  await expect.poll(() => page.locator(`${EDITOR} .bn-inline-content`).allTextContents()).toEqual(['alpha', 'beta', 'gamma']);
});

test('dragging the divider between two columns changes their widths, and one undo takes it back', async () => {
  await openWithLines(page, ['alpha', 'beta']);
  const a = await row(page, 'alpha').boundingBox();
  if (a === null) throw new Error('no alpha');
  await dragRowTo(page, 'beta', { x: a.x + a.width - 6, y: a.y + a.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'beta']]);

  const widths = (): Promise<number[]> =>
    page.locator(`${EDITOR} .doc-column`).evaluateAll((list) => list.map((column) => Math.round(column.getBoundingClientRect().width)));
  const before = await widths();
  const [left, right] = await page.locator(`${EDITOR} .doc-column`).evaluateAll((list) => list.map((column) => column.getBoundingClientRect()).map((r) => ({ x: r.x, right: r.right, y: r.y })));
  const middle = (left!.right + right!.x) / 2;
  await page.mouse.move(middle - 40, left!.y + 8);
  await page.mouse.move(middle, left!.y + 8, { steps: 4 });
  await expect(page.locator(`${EDITOR} .doc-column-divider`)).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(middle + 100, left!.y + 8, { steps: 8 });
  await page.mouse.up();
  const after = await widths();
  expect(after[0]! - before[0]!).toBeGreaterThan(80);
  expect(before[1]! - after[1]!).toBeGreaterThan(80);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(widths).toEqual(before);
});
