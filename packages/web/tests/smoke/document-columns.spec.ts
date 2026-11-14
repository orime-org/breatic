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

test('dragging a row onto the right edge of another stands them in two columns, where the first row stood', async () => {
  await openWithLines(page, ['alpha', 'beta', 'gamma']);
  const target = await row(page, 'alpha').boundingBox();
  if (target === null) throw new Error('no alpha');
  await dragRowTo(page, 'gamma', { x: target.x + target.width - 6, y: target.y + target.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'gamma']]);
  const columns = await page.locator(`${EDITOR} .doc-column`).evaluateAll((list) =>
    list.map((column) => column.getBoundingClientRect().left),
  );
  expect(columns[1]! - columns[0]!).toBeGreaterThan(200);
  // The group opens the body, so its lines sit at the top as alpha did.
  for (const words of ['alpha', 'gamma']) {
    expect(Math.round((await row(page, words).boundingBox())!.y)).toBe(Math.round(target.y));
  }
});

test('dragging a row into the empty space right of a narrow block still lands beside it', async () => {
  await openWithLines(page, ['alpha', 'beta']);
  const target = await row(page, 'alpha').boundingBox();
  if (target === null) throw new Error('no alpha');
  // Past the body's right edge, in the page margin, level with alpha.
  await dragRowTo(page, 'beta', { x: target.x + target.width + 120, y: target.y + target.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'beta']]);
});

test('dragging a row into the left half of the gap between two columns lands right of the left column', async () => {
  await openWithLines(page, ['alpha', 'beta', 'gamma']);
  const alpha = (await row(page, 'alpha').boundingBox())!;
  await dragRowTo(page, 'beta', { x: alpha.x + alpha.width - 6, y: alpha.y + alpha.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'beta']]);
  const [left, right] = await page.locator(`${EDITOR} .doc-column`).evaluateAll((list) =>
    list.map((column) => column.getBoundingClientRect().toJSON() as DOMRect),
  );
  const line = (await row(page, 'alpha').boundingBox())!;
  // A quarter of the way across the gap, short of the second column's handle.
  await dragRowTo(page, 'gamma', { x: left!.right + (right!.left - left!.right) / 4, y: line.y + line.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'gamma', 'beta']]);
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
  // The group opens its cell, so its lines sit level with the next cell's first line.
  const firsts = await group.evaluate((element) =>
    [...element.closest('tr')!.children].map((cell) => Math.round(cell.querySelector('.bn-block-content')!.getBoundingClientRect().top)),
  );
  expect(firsts[0]).toBe(firsts[1]);
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

test('dragging a row into the right page margin level with a table stands it beside the table', async () => {
  await openWithLines(page, ['lead']);
  await page.mouse.move(5, 5);
  const lead = (await row(page, 'lead').boundingBox())!;
  await page.mouse.move(lead.x + 30, lead.y + lead.height / 2, { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await page.keyboard.type('one');
  const table = (await page.locator(`${EDITOR} [data-node-type="docTable"]`).first().boundingBox())!;
  const body = (await page.locator(`${EDITOR} .bn-block-group`).first().boundingBox())!;
  await dragRowTo(page, 'lead', { x: body.x + body.width + 120, y: table.y + table.height / 2 });
  await expect.poll(() => page.locator(`${EDITOR} .doc-column > [data-node-type="docTable"]`).count()).toBe(1);
  expect(await page.locator(`${EDITOR} td .doc-columns`).count()).toBe(0);
});

test('in a wide window, the page margin far right of the body still takes a side drop', async () => {
  await page.setViewportSize({ width: 2600, height: 950 });
  await openWithLines(page, ['alpha', 'beta']);
  const alpha = (await row(page, 'alpha').boundingBox())!;
  const body = (await page.locator(`${EDITOR} .bn-block-group`).first().boundingBox())!;
  const x = body.x + body.width + 500;
  expect(x).toBeLessThan(2600 - 20);
  await dragRowTo(page, 'beta', { x, y: alpha.y + alpha.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['alpha', 'beta']]);
});

test('above the body, level with no line, the right margin shows no side line', async () => {
  await openWithLines(page, ['alpha', 'beta']);
  const scroller = (await page.locator('[data-testid="document-space"] .doc-body-scroller').first().boundingBox())!;
  const body = (await page.locator(`${EDITOR} .bn-block-group`).first().boundingBox())!;
  const x = Math.min(body.x + body.width + 40, page.viewportSize()!.width - 10);
  await page.mouse.move(5, 5);
  const alpha = (await row(page, 'alpha').boundingBox())!;
  const beta = (await row(page, 'beta').boundingBox())!;
  await page.mouse.move(beta.x + 30, beta.y + beta.height / 2, { steps: 3 });
  const grip = (await page.getByTestId('doc-block-handle').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  const side = page.locator('.prosemirror-dropcursor-block-vertical-right, .prosemirror-dropcursor-block-vertical-left');
  let level: number;
  let above: number;
  try {
    // Level with alpha the margin takes a side drop; above the body it does not.
    await page.mouse.move(x, alpha.y + alpha.height / 2, { steps: 12 });
    // The drag starts partway through the long move; a few more settle the line.
    await page.mouse.move(x - 4, alpha.y + alpha.height / 2, { steps: 2 });
    await page.mouse.move(x, alpha.y + alpha.height / 2, { steps: 2 });
    await page.waitForTimeout(300);
    level = await side.count();
    await page.mouse.move(x, scroller.y - 20, { steps: 6 });
    await page.waitForTimeout(300);
    above = await side.count();
  } finally {
    await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  expect(level).toBe(1);
  expect(above).toBe(0);
});

test('one undo takes back columns made in a narrow cell together with the widened column', async () => {
  await openWithLines(page, ['lead']);
  await page.mouse.move(5, 5);
  const lead = (await row(page, 'lead').boundingBox())!;
  await page.mouse.move(lead.x + 30, lead.y + lead.height / 2, { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  const widths = (): Promise<number[]> =>
    page.locator(`${EDITOR} tr`).first().locator('td').evaluateAll((cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width)));
  const before = await widths();
  const one = (await row(page, 'one').boundingBox())!;
  await dragRowTo(page, 'two', { x: one.x + one.width - 4, y: one.y + one.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['one', 'two']]);
  await expect.poll(widths).not.toEqual(before);
  await row(page, 'one').click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => groups(page)).toEqual([]);
  expect(await widths()).toEqual(before);
});

/**
 * Inserts a 2 × 2 table under a line off the handle's insert menu.
 * @param p - The page.
 * @param words - The line's words.
 */
async function tableUnder(p: Page, words: string): Promise<void> {
  await p.mouse.move(5, 5);
  const line = (await row(p, words).boundingBox())!;
  await p.mouse.move(line.x + 30, line.y + line.height / 2, { steps: 3 });
  await p.getByTestId('doc-block-handle').click();
  await p.getByTestId('doc-block-row-insertBelow').hover();
  await p.getByTestId('doc-block-insert-table').hover();
  await p.getByTestId('doc-table-size-2-2').click();
}

test('a block in a cell of a table in a column has its handle in the gap\'s right half', async () => {
  await openWithLines(page, ['alpha', 'lead']);
  await tableUnder(page, 'lead');
  await page.keyboard.type('one');
  // The table's own handle, from the gutter level with its first row.
  await page.mouse.move(5, 5);
  const first = (await page.locator(`${EDITOR} tr`).first().boundingBox())!;
  await page.mouse.move(first.x - 52, first.y + first.height / 2, { steps: 3 });
  const tableGrip = page.getByTestId('doc-block-table-handle');
  await expect(tableGrip).toBeVisible();
  const grip = (await tableGrip.boundingBox())!;
  const alpha = (await row(page, 'alpha').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2, { steps: 3 });
  await page.mouse.down();
  await page.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  await page.mouse.move(alpha.x + alpha.width - 6, alpha.y + alpha.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.locator(`${EDITOR} .doc-column > [data-node-type="docTable"]`).count()).toBe(1);
  await row(page, 'alpha').click();

  const column = (await page.locator(`${EDITOR} .doc-column`).nth(1).boundingBox())!;
  await page.mouse.move(5, 5);
  const words = (await page.locator(`${EDITOR} .doc-column td .bn-inline-content`).filter({ hasText: /^one$/ }).boundingBox())!;
  await page.mouse.move(words.x + 4, words.y + words.height / 2, { steps: 3 });
  const blockGrip = page.getByTestId('doc-block-handle');
  await expect(blockGrip).toBeVisible();
  const own = (await blockGrip.boundingBox())!;
  expect(own.x).toBeGreaterThanOrEqual(column.x - 36 - 1);
  expect(own.x + own.width).toBeLessThanOrEqual(column.x);
});

test('in a cell, the handle of a block in a group\'s first column keeps off the cell line', async () => {
  await openWithLines(page, ['lead']);
  await tableUnder(page, 'lead');
  await page.keyboard.press('Tab');
  await page.keyboard.type('p');
  await page.keyboard.press('Enter');
  await page.keyboard.type('q');
  const p = (await row(page, 'p').boundingBox())!;
  await dragRowTo(page, 'q', { x: p.x + p.width - 4, y: p.y + p.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['p', 'q']]);
  const cell = (await page.locator(`${EDITOR} td`).filter({ has: page.locator('.doc-columns') }).boundingBox())!;
  await page.mouse.move(5, 5);
  const words = (await row(page, 'p').boundingBox())!;
  await page.mouse.move(words.x + 4, words.y + words.height / 2, { steps: 3 });
  const grip = page.getByTestId('doc-block-handle');
  await expect(grip).toBeVisible();
  const box = (await grip.boundingBox())!;
  // The cell line's resize zone reaches 5px either side of it.
  expect(box.x + box.width).toBeLessThanOrEqual(cell.x - 5);
});

test('a press on the handle that ends just off it lets the handle follow the pointer again', async () => {
  await openWithLines(page, ['alpha', 'beta', 'gamma']);
  await page.mouse.move(5, 5);
  const alpha = (await row(page, 'alpha').boundingBox())!;
  await page.mouse.move(alpha.x + 30, alpha.y + alpha.height / 2, { steps: 3 });
  const handle = page.getByTestId('doc-block-handle');
  await expect(handle).toBeVisible();
  const grip = (await handle.boundingBox())!;
  // Pressed at its right edge and let go a pixel past it: no click, no drag.
  await page.mouse.move(grip.x + grip.width - 0.5, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width + 0.6, grip.y + grip.height / 2);
  await page.mouse.up();
  const gamma = (await row(page, 'gamma').boundingBox())!;
  await page.mouse.move(gamma.x + 30, gamma.y + gamma.height / 2, { steps: 6 });
  await expect.poll(async () => {
    const box = await handle.boundingBox();
    return box === null ? null : Math.abs(box.y + box.height / 2 - (gamma.y + gamma.height / 2)) < 8;
  }).toBe(true);
});

test('a table in a column opened full screen shows alone, its group\'s other column gone', async () => {
  await openWithLines(page, ['lead', 'alpha']);
  await tableUnder(page, 'lead');
  await page.keyboard.type('one');
  const table = (await page.locator(`${EDITOR} [data-node-type="docTable"]`).first().boundingBox())!;
  const body = (await page.locator(`${EDITOR} .bn-block-group`).first().boundingBox())!;
  await dragRowTo(page, 'alpha', { x: body.x + body.width + 40, y: table.y + table.height / 2 });
  await expect.poll(() => page.locator(`${EDITOR} .doc-column > [data-node-type="docTable"]`).count()).toBe(1);
  await row(page, 'lead').click();
  await page.mouse.move(5, 5);
  const first = (await page.locator(`${EDITOR} tr`).first().boundingBox())!;
  await page.mouse.move(first.x - 52, first.y + first.height / 2, { steps: 3 });
  await page.getByTestId('doc-block-table-handle').click();
  await page.getByTestId('doc-block-row-fullscreen').click();

  await expect(page.locator('[data-table-fullscreen]')).toBeVisible();
  await expect(row(page, 'alpha')).toBeHidden();
  await expect(row(page, 'lead')).toBeHidden();
  await expect(page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^one$/ })).toBeVisible();
  // The table takes the body's width, not its column's.
  const shown = (await page.locator(`${EDITOR} [data-node-type="docTable"]`).first().boundingBox())!;
  const surface = (await page.locator(`${EDITOR} .bn-block-group`).first().boundingBox())!;
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-table-fullscreen]')).toHaveCount(0);
  expect(shown.width).toBeGreaterThan(surface.width - 2);
});

test('dragging a row into a cell\'s left padding lands beside the cell\'s block, inside the cell', async () => {
  await openWithLines(page, ['lead', 'moved']);
  await tableUnder(page, 'lead');
  await page.keyboard.type('one');
  const cell = page.locator(`${EDITOR} td`).first();
  const box = (await cell.boundingBox())!;
  const line = (await row(page, 'one').boundingBox())!;
  // In the cell's padding, left of its block's words.
  await dragRowTo(page, 'moved', { x: box.x + 4, y: line.y + line.height / 2 });
  await expect.poll(() => groups(page)).toEqual([['moved', 'one']]);
  await expect(cell.locator('.doc-columns')).toHaveCount(1);
});
