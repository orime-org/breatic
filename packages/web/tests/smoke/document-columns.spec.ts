// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314: blocks dragged beside each other stand in columns.
 *
 * Every case drives the browser's own HTML5 drag with the mouse (a press on
 * the handle, a small move, a move onto the target), which is the path a
 * user's drag takes through BlockNote's drop cursor and ProseMirror's drop.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

test('columns made in a cell of a fresh table widen its column to hold them side by side', async () => {
  await openWithLines(page, ['lead']);
  // A 2 × 2 table off the handle's insert menu: no stored widths.
  await page.mouse.move(5, 5);
  const lead = await row(page, 'lead').boundingBox();
  if (lead === null) throw new Error('no lead');
  await page.mouse.move(lead.x + 30, lead.y + lead.height / 2, { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  const one = await row(page, 'one').boundingBox();
  if (one === null) throw new Error('no one');
  await dragRowTo(page, 'two', { x: one.x + one.width - 4, y: one.y + one.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['one', 'two']]);
  const group = page.locator(`${EDITOR} .doc-columns`);
  await expect(group).not.toHaveAttribute('data-stacked', '');
  const width = await group.evaluate((element) => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(264);
  const tops = await page.locator(`${EDITOR} .doc-column`).evaluateAll((list) => list.map((column) => Math.round(column.getBoundingClientRect().top)));
  expect(tops[0]).toBe(tops[1]);
});

test('a press in a column group that ends the body selects its words, as in a table', async () => {
  await openWithLines(page, ['alpha', 'beta']);
  const a = await row(page, 'alpha').boundingBox();
  if (a === null) throw new Error('no alpha');
  await dragRowTo(page, 'beta', { x: a.x + a.width - 6, y: a.y + a.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'beta']]);

  const words = page.locator(`${EDITOR} .bn-inline-content`, { hasText: /^alpha$/ });
  const box = await words.boundingBox();
  if (box === null) throw new Error('no words');
  const text = await words.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { left: rect.left, right: rect.right };
  });
  // From the end of the words back to their start: a press taken as the
  // body's end would anchor the range at the end of the body instead.
  await page.mouse.move(text.right + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(text.left - 2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('alpha');
});

test('a Shift+click in a column group that ends the body ends the range where it lands', async () => {
  await openWithLines(page, ['alpha', 'betagamma']);
  const a = await row(page, 'alpha').boundingBox();
  if (a === null) throw new Error('no alpha');
  await dragRowTo(page, 'betagamma', { x: a.x + a.width - 6, y: a.y + a.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'betagamma']]);

  const reach = async (words: string): Promise<{ left: number; right: number; y: number }> =>
    page.locator(`${EDITOR} .bn-inline-content`, { hasText: new RegExp(`^${words}$`) }).evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
    });
  const first = await reach('alpha');
  const second = await reach('betagamma');
  await page.mouse.click(first.left + 1, first.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(second.left + (second.right - second.left) * 0.45, second.y);
  await page.keyboard.up('Shift');
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected).toContain('alpha');
  expect(selected).toContain('beta');
  expect(selected).not.toContain('gamma');
});

test('the line beside a narrow picture stands at the picture\'s own edge', async () => {
  await openWithLines(page, ['alpha', '']);
  await page.locator(EDITOR).evaluate((element, base64) => {
    const transfer = new DataTransfer();
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([raw], 'portrait.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, readFileSync(resolve(__dirname, '../fixtures/portrait.png')).toString('base64'));
  const media = page.locator(`${EDITOR} [data-content-type="image"] [data-media-box]`).first();
  await expect(media).toBeVisible({ timeout: 60_000 });
  const picture = (await media.boundingBox())!;
  const body = (await page.locator(`${EDITOR} .bn-block-group`).first().boundingBox())!;
  expect(picture.x + picture.width).toBeLessThan(body.x + body.width - 100);

  await page.mouse.move(5, 5);
  const a = (await row(page, 'alpha').boundingBox())!;
  await page.mouse.move(a.x + 30, a.y + a.height / 2, { steps: 3 });
  const grip = (await page.getByTestId('doc-block-handle').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  await page.mouse.move(picture.x + picture.width - 6, picture.y + picture.height / 2, { steps: 12 });
  const line = page.locator('.prosemirror-dropcursor-block-vertical-right');
  let drawn: { x: number; width: number } | null;
  try {
    await expect(line).toBeVisible();
    drawn = await line.boundingBox();
  } finally {
    await page.mouse.up();
  }
  expect(Math.abs(drawn!.x + drawn!.width / 2 - (picture.x + picture.width))).toBeLessThan(8);
  await expect.poll(() => groups(page)).toHaveLength(1);
});
