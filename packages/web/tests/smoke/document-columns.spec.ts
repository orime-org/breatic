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
  await p.mouse.move(grip.x + 10, grip.y + 10, { steps: 3 });
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
      [...list.querySelectorAll(':scope > .doc-column')].map((column) =>
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
