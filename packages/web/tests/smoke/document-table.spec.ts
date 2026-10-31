// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tables in a document, end to end (inner#1126), with cells that hold
 * blocks (inner#1619).
 *
 * The half jsdom cannot reach: the handles appear for a pointer over a cell,
 * which needs real layout; dragging a row, a column or a column's edge, and
 * selecting across cells, are real pointer gestures; a pasted table comes in
 * through a real clipboard event; two pages on one Space are two real
 * connections. Every table here is made the way a reader makes one, off the
 * block menu's grid, and every case checks the page threw nothing.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Browser, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { clickAndSettle, pressAndSettle, selectInBody } from '../helpers/editor-keys';
import { resizeDocumentColumn } from '../helpers/document-table-geometry';
import { roomForUploads } from '../helpers/upload-budget';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, visibleSpace } from '../helpers/space';

let page: Page;
let errors: string[];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
  expect(errors).toEqual([]);
});

// A top-level row: a block's content, or a table's frame, which stands in the
// body's block group itself.
const TOP = `${EDITOR} > .bn-block-group > .bn-block-outer > .bn-block > .bn-block-content, ${EDITOR} > .bn-block-group > [data-node-type='docTable']`;

/**
 * Open a freshly made Document Space holding one line, the caret at its end.
 * @param p - The page.
 * @returns The Space's id.
 */
async function openFreshDocument(p: Page): Promise<string> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `table-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await p.keyboard.type('lead');
  return id;
}

/**
 * Put the pointer over a top-level row, so the strip appears beside it.
 * @param p - The page.
 * @param index - Which row, from the top.
 * @throws {Error} When that row has no box.
 */
async function hoverRow(p: Page, index: number): Promise<void> {
  await p.mouse.move(5, 5);
  const box = await p.locator(TOP).nth(index).boundingBox();
  if (box === null) throw new Error(`row ${index} has no box`);
  await p.mouse.move(box.x + 40, box.y + Math.min(box.height / 2, 12), { steps: 3 });
  await expect(p.getByTestId(/^doc-block-(table-)?handle$|^doc-block-plus$/).first()).toBeVisible();
}

/**
 * Insert a table under the first line, off its handle's menu and the grid.
 * @param p - The page.
 * @param rows - How many rows.
 * @param cols - How many columns.
 */
async function insertTable(p: Page, rows: number, cols: number): Promise<void> {
  const before = await p.locator(`${EDITOR} table`).count();
  await hoverRow(p, 0);
  await p.getByTestId('doc-block-handle').click();
  await p.getByTestId('doc-block-row-insertBelow').hover();
  await p.getByTestId('doc-block-insert-table').hover();
  await p.getByTestId(`doc-table-size-${rows}-${cols}`).click();
  await expect(p.locator(`${EDITOR} table`)).toHaveCount(before + 1);
}

/**
 * Type into the cells in reading order, moving with Tab.
 * @param p - The page.
 * @param words - One entry per cell, from the caret's cell on.
 */
async function fill(p: Page, words: readonly string[]): Promise<void> {
  for (const [index, word] of words.entries()) {
    if (index > 0) await p.keyboard.press('Tab');
    await p.keyboard.type(word);
  }
}

/**
 * The tables as cell texts, a header cell marked with #. What the editor
 * draws over the text (another person's caret and name) is left out.
 * @param p - The page.
 * @returns One grid per table.
 */
async function grids(p: Page): Promise<string[][][]> {
  return p.evaluate((selector) =>
    Array.from(document.querySelectorAll(`${selector} table`)).map((table) =>
      Array.from(table.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.children).map((c) => {
          const words = c.cloneNode(true) as Element;
          words.querySelectorAll('[contenteditable="false"]').forEach((drawn) => drawn.remove());
          return `${c.tagName === 'TH' ? '#' : ''}${words.textContent ?? ''}`;
        }),
      ),
    ),
  EDITOR);
}

/**
 * A cell holding exactly these words.
 * @param p - The page.
 * @param text - The words.
 * @returns Its locator.
 */
function cell(p: Page, text: string): ReturnType<Page['locator']> {
  return p.locator(`${EDITOR} td, ${EDITOR} th`).filter({ hasText: new RegExp(`^${text}$`) }).first();
}

/**
 * Put the pointer in the middle of a cell, with the caret out of the table.
 * @param p - The page.
 * @param text - The cell's words.
 * @throws {Error} When the cell has no box.
 */
async function hoverCell(p: Page, text: string): Promise<void> {
  await p.mouse.move(5, 5);
  const box = await cell(p, text).boundingBox();
  if (box === null) throw new Error(`no cell ${text}`);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
}

/**
 * Put the pointer in the gutter left of a table, level with its first row, so
 * the table's own handle appears.
 * @param p - The page.
 * @throws {Error} When the table has no box.
 */
async function hoverTable(p: Page): Promise<void> {
  await p.mouse.move(5, 5);
  const row = await p.locator(`${EDITOR} tr`).first().boundingBox();
  if (row === null) throw new Error('no table row');
  // Past the strips of the first column's blocks, which stand within 40px of
  // the table's left line, on the table's own strip.
  await p.mouse.move(row.x - 52, row.y + row.height / 2, { steps: 3 });
  await expect(p.getByTestId('doc-block-table-handle')).toBeVisible();
}

/**
 * Put the pointer on some words in a cell, so their block's handle appears.
 * @param p - The page.
 * @param text - The words.
 * @returns The handle.
 * @throws {Error} When the words have no box.
 */
async function hoverWordsInCell(p: Page, text: string): Promise<ReturnType<Page['locator']>> {
  await p.mouse.move(5, 5);
  const words = p.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: new RegExp(`^${text}$`) }).first();
  const box = await words.boundingBox();
  if (box === null) throw new Error(`no words ${text}`);
  await p.mouse.move(box.x + 4, box.y + box.height / 2, { steps: 3 });
  const handle = p.getByTestId('doc-block-handle');
  await expect(handle).toBeVisible();
  return handle;
}

/**
 * Drag from a handle to a point, the way a hand does: a short move to start
 * the drag, then the way there.
 * @param p - The page.
 * @param handle - The handle.
 * @param to - Where it is dropped.
 * @param to.x - Across.
 * @param to.y - Down.
 * @throws {Error} When the handle has no box.
 */
async function dragHandle(p: Page, handle: ReturnType<Page['locator']>, to: { x: number; y: number }): Promise<void> {
  const box = await handle.boundingBox();
  if (box === null) throw new Error('the handle has no box');
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + 8, box.y + 12, { steps: 4 });
  await p.mouse.move(to.x, to.y, { steps: 10 });
  await p.mouse.up();
}

/**
 * The blocks in each cell, as their content types, row by row.
 * @param p - The page.
 * @returns One list of types per cell.
 */
async function cellBlocks(p: Page): Promise<string[][][]> {
  return p.evaluate((selector) =>
    Array.from(document.querySelectorAll(`${selector} tr`)).map((tr) =>
      Array.from(tr.children).map((c) =>
        Array.from(c.querySelectorAll('.bn-block-content')).map((b) => {
          const type = b.getAttribute('data-content-type') ?? '';
          const words = b.textContent ?? '';
          return words === '' ? type : `${type}:${words}`;
        }),
      ),
    ),
  EDITOR);
}

/**
 * Drag across cells, from the middle of one to the middle of another.
 * @param p - The page.
 * @param from - The first cell, by its words or its index among the cells.
 * @param to - The last cell, the same way.
 * @throws {Error} When either cell has no box.
 */
async function selectCells(p: Page, from: string | number, to: string | number): Promise<void> {
  const at = (which: string | number): ReturnType<Page['locator']> =>
    typeof which === 'number' ? p.locator(`${EDITOR} td`).nth(which) : cell(p, which);
  const a = await at(from).boundingBox();
  const b = await at(to).boundingBox();
  if (a === null || b === null) throw new Error('a cell has no box');
  // On the cell's words, right of a first-column block's handle on the table's left line.
  await p.mouse.move(a.x + 20, a.y + a.height / 2);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width - 10, b.y + b.height / 2, { steps: 6 });
  await p.mouse.up();
  await expect(p.locator(`${EDITOR} .selectedCell`).first()).toBeVisible();
}

/**
 * A table of 2 × 2 filled with a1 b1 / a2 b2, the caret back on the first line.
 * @param p - The page.
 */
async function smallTable(p: Page): Promise<void> {
  await insertTable(p, 2, 2);
  await fill(p, ['a1', 'b1', 'a2', 'b2']);
  await p.locator(TOP).first().click();
}

test('A1: the grid inserts a table of the size picked, the caret in its first cell', async () => {
  await openFreshDocument(page);
  await hoverRow(page, 0);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await expect(page.getByTestId('doc-table-size-label')).toHaveText('Select a size');
  await page.getByTestId('doc-table-size-3-4').hover();
  await expect(page.getByTestId('doc-table-size-label')).toHaveText('3 rows × 4 columns');
  await expect(page.locator('[data-testid^="doc-table-size-"][data-on]')).toHaveCount(12);

  await page.getByTestId('doc-table-size-3-4').click();
  await page.keyboard.type('x');

  expect(await grids(page)).toEqual([[['x', '', '', ''], ['', '', '', ''], ['', '', '', '']]]);
  // The line it was inserted under, the table, and an empty line after it.
  await expect(page.locator(TOP)).toHaveCount(3);
});

test('A2: the plus on an empty line turns that line into a table, and one undo takes it back', async () => {
  await openFreshDocument(page);
  await page.keyboard.press('Enter');
  await hoverRow(page, 1);
  await page.getByTestId('doc-block-plus').click();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
  await expect(page.locator(TOP)).toHaveCount(2);

  await page.keyboard.press('ControlOrMeta+z');

  await expect(page.locator(`${EDITOR} table`)).toHaveCount(0);
});

test('A3 and T3: words in a cell take styles there only, and Enter splits the block inside the cell', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  for (let i = 0; i < 'two'.length; i += 1) await pressAndSettle(page, 'Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+b');

  expect((await cellBlocks(page))[0][0]).toEqual(['paragraph:one', 'paragraph:two']);
  await expect(cell(page, 'onetwo').locator('strong')).toHaveText('two');
  await expect(page.locator(`${EDITOR} strong`)).toHaveCount(1);
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
});

test('A4: Tab and Shift+Tab move between cells, and Tab in the last cell adds a row', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await fill(page, ['a1', 'b1', 'a2', 'b2']);
  await page.keyboard.press('Tab');
  await page.keyboard.type('a3');
  // Moving into a cell selects its words, as in Word; the arrow collapses that
  // to their end.
  await page.keyboard.press('Shift+Tab');
  await pressAndSettle(page, 'ArrowRight');
  await page.keyboard.type('!');

  expect(await grids(page)).toEqual([[['a1', 'b1'], ['a2', 'b2!'], ['a3', '']]]);
});

test('A4: ArrowDown from the last row of a table the body ends with opens a line under it', async () => {
  await openFreshDocument(page);
  await page.keyboard.press('Enter');
  await hoverRow(page, 1);
  await page.getByTestId('doc-block-plus').click();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await expect(page.locator(TOP)).toHaveCount(2);
  await fill(page, ['a1', 'b1', 'a2']);

  await pressAndSettle(page, 'ArrowDown');
  await page.keyboard.type('below');

  await expect(page.locator(TOP)).toHaveCount(3);
  await expect(page.locator(TOP).nth(2)).toHaveText('below');
  expect(await grids(page)).toEqual([[['a1', 'b1'], ['a2', '']]]);
});

test('A4: ArrowUp from the first row of a table the body starts with opens a line above it', async () => {
  await openFreshDocument(page);
  for (let i = 0; i < 'lead'.length; i += 1) await page.keyboard.press('Backspace');
  await hoverRow(page, 0);
  await page.getByTestId('doc-block-plus').click();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await expect(page.locator(TOP)).toHaveCount(1);
  await fill(page, ['a1', 'b1']);

  await pressAndSettle(page, 'ArrowUp');
  await page.keyboard.type('above');

  await expect(page.locator(TOP)).toHaveCount(2);
  await expect(page.locator(TOP).nth(0)).toHaveText('above');
  expect(await grids(page)).toEqual([[['a1', 'b1'], ['', '']]]);
});

test('A5: the table icon opens the table menu, and dragging it moves the whole table', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await hoverTable(page);
  const entry = page.getByTestId('doc-block-table-handle');
  const icon = await entry.boundingBox();
  const firstRow = await page.locator(`${EDITOR} tr`).first().boundingBox();
  expect(Math.abs(icon!.y + icon!.height / 2 - (firstRow!.y + firstRow!.height / 2))).toBeLessThan(2);

  await entry.click();
  const rows = await page.locator('[data-testid^="doc-block-row-"]').evaluateAll((els) =>
    els.map((el) => `${el.getAttribute('data-testid')}${el.getAttribute('aria-disabled') === 'true' ? ' off' : ''}`),
  );
  expect(rows).toEqual([
    'doc-block-row-insertBelow',
    'doc-block-row-duplicate',
    'doc-block-row-indent',
    'doc-block-row-unindent off',
    'doc-block-row-comment',
    'doc-block-row-addToAgent',
    'doc-block-row-delete',
  ]);
  await page.keyboard.press('Escape');
  await expect(page.locator(EDITOR)).toBeFocused();

  // A line under the table to drop it below.
  await clickAndSettle(page, page.locator(TOP).nth(2));
  await page.keyboard.type('tail');
  await hoverTable(page);
  const handle = await page.getByTestId('doc-block-table-handle').boundingBox();
  const tail = await page.locator(TOP).nth(2).boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 8, handle!.y + 12, { steps: 4 });
  await page.mouse.move(tail!.x + 40, tail!.y + tail!.height - 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(TOP).nth(1)).toHaveText('tail');
  await expect(page.locator(TOP).nth(2).locator('table')).toHaveCount(1);
  expect(await grids(page)).toEqual([[['a1', 'b1'], ['a2', 'b2']]]);
});

test('A6: the row and column handles insert, delete and set the header', async () => {
  await openFreshDocument(page);
  await smallTable(page);

  await hoverCell(page, 'b2');
  await page.getByTestId('doc-table-row-handle').click();
  await page.getByTestId('doc-table-row-insertBelow').click();
  expect(await grids(page)).toEqual([[['a1', 'b1'], ['a2', 'b2'], ['', '']]]);

  await hoverCell(page, 'b1');
  await page.getByTestId('doc-table-col-handle').click();
  await page.getByTestId('doc-table-col-delete').click();
  expect(await grids(page)).toEqual([[['a1'], ['a2'], ['']]]);

  await hoverCell(page, 'a2');
  await page.getByTestId('doc-table-row-handle').click();
  await expect(page.getByTestId('doc-table-row-header')).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  await hoverCell(page, 'a1');
  await page.getByTestId('doc-table-row-handle').click();
  await page.getByTestId('doc-table-row-header').click();
  expect(await grids(page)).toEqual([[['#a1'], ['a2'], ['']]]);
});

test('A7: dragging a row by its handle moves it, with a line where it lands', async () => {
  await openFreshDocument(page);
  await insertTable(page, 3, 2);
  await fill(page, ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  await page.locator(TOP).first().click();

  await hoverCell(page, 'a1');
  const handle = await page.getByTestId('doc-table-row-handle').boundingBox();
  const last = await cell(page, 'a3').boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 4, handle!.y + 10, { steps: 4 });
  await page.mouse.move(last!.x + 30, last!.y + last!.height - 3, { steps: 8 });
  await expect(page.locator('.doc-table-drop-row-after')).toHaveCount(2);
  // The table's own line is the only one: the editor's drop line, which says
  // where words would land, is held back (inner#1404).
  await expect(page.locator('.prosemirror-dropcursor-block, .prosemirror-dropcursor-inline')).toHaveCount(0);
  await page.mouse.up();

  expect(await grids(page)).toEqual([[['a2', 'b2'], ['a3', 'b3'], ['a1', 'b1']]]);
  await expect(page.locator('[class*="doc-table-drop-"]')).toHaveCount(0);
});

test('a table has no plus along its edges: rows and columns are added from their handles', async () => {
  await openFreshDocument(page);
  await smallTable(page);

  await hoverCell(page, 'b2');
  const b2 = await cell(page, 'b2').boundingBox();
  await page.mouse.move(b2!.x + b2!.width / 2, b2!.y + b2!.height + 6, { steps: 3 });
  await page.mouse.move(b2!.x + b2!.width + 6, b2!.y + b2!.height / 2, { steps: 3 });

  await expect(page.locator('[data-testid^="doc-table-extend-"]')).toHaveCount(0);
});

test('A12: a wide table scrolled with the wheel shows its scrollbar under the last row, not over it', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 9);
  await fill(page, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  await page.locator(TOP).first().click();
  const table = page.locator(`${EDITOR} table`).first();
  const box = await table.boundingBox();
  await page.mouse.move(box!.x + 300, box!.y + 10);
  await page.mouse.wheel(200, 0);

  const rail = await table.evaluate((t) =>
    t.closest('[data-scrollbars]')!.querySelector('[data-orientation="horizontal"]')!.getBoundingClientRect().top,
  );
  const after = await table.boundingBox();
  expect(rail).toBeGreaterThanOrEqual(after!.y + after!.height - 1);
});

test('A9 and A10: selecting cells offers a merge, and a merged cell splits back', async () => {
  await openFreshDocument(page);
  await smallTable(page);

  await selectCells(page, 'a1', 'b1');
  await expect(page.getByTestId('doc-bubble-block-type')).toBeEnabled();
  await page.getByTestId('doc-bubble-tool-mergeCells').click();
  await expect(page.locator(`${EDITOR} tr`).first().locator('td')).toHaveCount(1);
  expect((await grids(page))[0][0]).toEqual(['a1b1']);

  await cell(page, 'a1b1').click();
  await page.getByTestId('doc-table-cell-button').click();
  await page.getByTestId('doc-table-cell-split').click();
  await expect(page.locator(`${EDITOR} tr`).first().locator('td')).toHaveCount(2);
});

test('A11: the cell button is on the hovered cell only, and aligns that cell', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await expect(page.getByTestId('doc-table-cell-button')).toHaveCount(0);

  await hoverCell(page, 'b2');
  const button = await page.getByTestId('doc-table-cell-button').boundingBox();
  const b2 = await cell(page, 'b2').boundingBox();
  expect(button!.x + button!.width).toBeLessThanOrEqual(b2!.x + b2!.width);
  expect(button!.y).toBeGreaterThanOrEqual(b2!.y);
  await page.getByTestId('doc-table-cell-button').click();
  await expect(page.getByTestId('doc-table-cell-split')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('doc-table-cell-align').hover();
  await page.getByTestId('doc-table-cell-align-center').click();

  const aligned = await page.locator(`${EDITOR} td`).evaluateAll((tds) =>
    tds.map((td) => getComputedStyle(td.querySelector('.bn-inline-content') ?? td).textAlign),
  );
  expect(aligned.filter((a) => a === 'center')).toHaveLength(1);

  // The cell was redrawn with its new alignment; the button comes up on it.
  await hoverCell(page, 'b2');
  await expect(page.getByTestId('doc-table-cell-button')).toBeVisible();
  const again = await page.getByTestId('doc-table-cell-button').boundingBox();
  const redrawn = await cell(page, 'b2').boundingBox();
  expect(again!.x + again!.width).toBeLessThanOrEqual(redrawn!.x + redrawn!.width);
  expect(again!.x).toBeGreaterThanOrEqual(redrawn!.x);
  expect(again!.y).toBeGreaterThanOrEqual(redrawn!.y);
});

test('T13: the row and column handles and the cell button go once the pointer leaves the table, the caret still in a cell (inner#1402)', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await cell(page, 'b2').click();
  await hoverCell(page, 'b2');
  for (const id of ['doc-table-row-handle', 'doc-table-col-handle', 'doc-table-cell-button']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  // Out of the body altogether, to the page's left edge.
  await page.mouse.move(2, 300, { steps: 4 });

  for (const id of ['doc-table-row-handle', 'doc-table-col-handle', 'doc-table-cell-button']) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
});

test('A11: after switching to another Space and back, the cell button follows the pointer again', async () => {
  const a = await openFreshDocument(page);
  await smallTable(page);
  await hoverCell(page, 'b2');
  await expect(page.getByTestId('doc-table-cell-button')).toBeVisible();

  const b = await createSpace(page, 'document', `table-other-${Date.now()}`);
  createdSpaceIds.push(b);
  await expect(page.locator(EDITOR)).toBeVisible({ timeout: 15_000 });
  await page.locator(EDITOR).click();
  await page.keyboard.type('elsewhere');
  await page.getByTestId(`space-tab-${a}`).click();
  await expect(cell(page, 'a1')).toBeVisible({ timeout: 15_000 });

  await hoverCell(page, 'a1');

  const button = await page.getByTestId('doc-table-cell-button').boundingBox();
  const a1 = await cell(page, 'a1').boundingBox();
  expect(button!.x).toBeGreaterThanOrEqual(a1!.x);
  expect(button!.x + button!.width).toBeLessThanOrEqual(a1!.x + a1!.width);
  expect(button!.y).toBeGreaterThanOrEqual(a1!.y);
  expect(button!.y + button!.height).toBeLessThanOrEqual(a1!.y + a1!.height);
});

test('T13: a block\'s handle stands outside its cell\'s left line; the first column has the table icon, the block\'s handle and the row handle left to right', async () => {
  await openFreshDocument(page);
  await smallTable(page);

  // A middle column: the handle in the cell to the left, clear of the line's
  // column-resize zone (5px either side).
  const middle = await (await hoverWordsInCell(page, 'b1')).boundingBox();
  const b1 = await cell(page, 'b1').boundingBox();
  expect(Math.abs(middle!.x + middle!.width - (b1!.x - 6))).toBeLessThan(2);
  const words = await page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^b1$/ }).first().boundingBox();
  // The cell keeps no room for the handle: its words start at the usual 10px.
  expect(words!.x - b1!.x).toBeLessThan(14);

  // The first column, on a row of one line (user 2026-10-21): the block's
  // handle where every other block's stands, 12px out from the table's left
  // line; the row handle centred on that line and on its row; the table icon
  // past the block's handle.
  const first = await (await hoverWordsInCell(page, 'a1')).boundingBox();
  const row = await page.getByTestId('doc-table-row-handle').boundingBox();
  const table = await page.locator(`${EDITOR} table`).first().boundingBox();
  const a1 = await cell(page, 'a1').boundingBox();
  expect(Math.abs(first!.x + first!.width - (table!.x - 12))).toBeLessThan(2);
  expect(Math.abs(row!.x + row!.width / 2 - table!.x)).toBeLessThan(2);
  expect(Math.abs(row!.y + row!.height / 2 - (a1!.y + a1!.height / 2))).toBeLessThan(2);
  // The table icon is up with them while the table is hovered (user
  // 2026-10-21), and stays up on the way to it across the other two.
  const entry = page.getByTestId('doc-block-table-handle');
  await expect(entry).toBeVisible();
  const icon = await entry.boundingBox();
  expect(Math.abs(icon!.x + icon!.width - (table!.x - 40))).toBeLessThan(2);
  await page.mouse.move(icon!.x + icon!.width / 2, icon!.y + icon!.height / 2, { steps: 16 });
  await expect(entry).toBeVisible();
  expect(await entry.boundingBox()).toEqual(icon);
});

test('T13: from the right of a first-column cell, the pointer reaches the block\'s handle and the row handle without either changing', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  const a1 = await cell(page, 'a1').boundingBox();
  const from = { x: a1!.x + a1!.width - 10, y: a1!.y + a1!.height - 6 };

  await page.mouse.move(from.x, from.y);
  const strip = page.getByTestId('doc-block-handle');
  await expect(strip).toBeVisible();
  const before = await strip.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2, { steps: 12 });
  expect(await strip.boundingBox()).toEqual(before);
  const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-testid="doc-block-handle"]') !== null, [before!.x + 12, before!.y + 12]);
  expect(under).toBe(true);

  await page.mouse.move(from.x, from.y);
  const handle = page.getByTestId('doc-table-row-handle');
  const row = await handle.boundingBox();
  await page.mouse.move(row!.x + row!.width / 2, row!.y + row!.height / 2, { steps: 12 });
  expect(await handle.boundingBox()).toEqual(row);
});

test('T13: on a table scrolled sideways, the handle of a block in the cell cut by the frame stands outside the frame\'s left line', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 9);
  await fill(page, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  await page.locator(TOP).first().click();
  const frame = page.locator(`${EDITOR} [data-radix-scroll-area-viewport]`).first();
  // c3 cut by the frame's left line, its words still in view.
  await frame.evaluate((viewport) => {
    const c3 = [...viewport.querySelectorAll('td')].find((td) => td.textContent === 'c3')!;
    viewport.scrollLeft = c3.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft + 6;
  });
  const box = await frame.boundingBox();
  expect((await cell(page, 'c3').boundingBox())!.x).toBeLessThan(box!.x);

  const strip = await (await hoverWordsInCell(page, 'c3')).boundingBox();
  expect(Math.abs(strip!.x + strip!.width - (box!.x - 12))).toBeLessThan(2);
});

test('T13: a block\'s handle in a middle column keeps its block while the pointer rests on it and someone edits elsewhere', async ({ browser }) => {
  const spaceId = await openFreshDocument(page);
  await smallTable(page);
  const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  try {
    await other.goto(page.url());
    await other.getByTestId(`space-tab-name-${spaceId}`).click();
    await expect(other.locator(`${EDITOR} table`)).toHaveCount(1, { timeout: 20_000 });

    const strip = await hoverWordsInCell(page, 'b1');
    const box = await strip.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 4 });
    const named = await page.locator('[data-row-id]').first().getAttribute('data-row-id');

    await clickAndSettle(other, cell(other, 'b2'));
    await other.keyboard.press('End');
    await other.keyboard.type('!');
    await expect.poll(() => grids(page)).toEqual([[['a1', 'b1'], ['a2', 'b2!']]]);

    await expect(page.locator('[data-row-id]').first()).toHaveAttribute('data-row-id', named!);
  } finally {
    await other.close();
  }
});

test('A6: the row and column handles sit centred on the table\'s lines, the table icon clear of the first row handle', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await hoverCell(page, 'a1');
  const row = await page.getByTestId('doc-table-row-handle').boundingBox();
  const column = await page.getByTestId('doc-table-col-handle').boundingBox();
  const table = await page.locator(`${EDITOR} table`).first().boundingBox();

  expect(Math.abs(row!.x + row!.width / 2 - table!.x)).toBeLessThan(1.5);
  expect(Math.abs(column!.y + column!.height / 2 - table!.y)).toBeLessThan(1.5);
  // WCAG 2.2 SC 2.5.8: the 24px circle around the 12px row handle stays clear
  // of the table icon beside it on the first row.
  await hoverTable(page);
  const icon = await page.getByTestId('doc-block-table-handle').boundingBox();
  expect(icon!.x + icon!.width).toBeLessThanOrEqual(row!.x + row!.width / 2 - 12 + 0.5);
});

test('A12: dragging a column edge widens it, and a wide table scrolls in its own frame', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  const before = await cell(page, 'a1').boundingBox();
  await page.mouse.move(before!.x + before!.width - 1, before!.y + 10);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width + 60, before!.y + 10, { steps: 6 });
  await page.mouse.up();
  const after = await cell(page, 'a1').boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width + 40);

  await insertTable(page, 1, 9);
  const frame = await page.locator(`${EDITOR} table`).first().evaluate((table) => {
    const viewport = table.closest('[data-radix-scroll-area-viewport]');
    return viewport === null ? null : { scroll: viewport.scrollWidth, client: viewport.clientWidth };
  });
  expect(frame).not.toBeNull();
  expect(frame!.scroll).toBeGreaterThan(frame!.client);
});

test('A12: dragging the last column wider leaves every other column as wide as it was', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 4);
  // A column whose words ask for more room than the others: the browser
  // widens it to fill what the table has left.
  await fill(page, ['', 'long words that wrap inside the second column of this table', '', '']);
  const widths = (): Promise<number[]> =>
    page.locator(`${EDITOR} table tr`).first().locator('td').evaluateAll((tds) =>
      tds.map((td) => Math.round(td.getBoundingClientRect().width)),
    );
  const before = await widths();
  // The edge of the second row's last cell, half way down: the caret is in
  // the first row's last cell, whose top-right corner holds its cell button.
  const last = await page.locator(`${EDITOR} table tr`).nth(1).locator('td').nth(3).boundingBox();
  const edge = last!.x + last!.width - 1;
  const y = last!.y + last!.height / 2;
  // Onto the edge from inside the cell, so the resize handle comes up first.
  await page.mouse.move(edge - 20, y);
  await page.mouse.move(edge, y, { steps: 3 });
  await expect(page.locator(`${EDITOR} .column-resize-handle`)).not.toHaveCount(0);
  await page.mouse.down();
  await page.mouse.move(edge + 150, y, { steps: 8 });
  await page.mouse.up();

  const after = await widths();
  expect(after.slice(0, 3)).toEqual(before.slice(0, 3));
  expect(after[3]).toBeGreaterThan(before[3] + 100);
});

test('A6, A11 and A12: on a wide table scrolled sideways, the row handle sits on the frame\'s left line and the cell button leaves with its cell', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 9);
  await fill(page, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  // The pointer over the first cell, then the table scrolled until that cell is out of sight.
  await cell(page, 'c1').scrollIntoViewIfNeeded();
  await hoverCell(page, 'c1');
  await expect(page.getByTestId('doc-table-cell-button')).toBeVisible();
  const frame = page.locator(`${EDITOR} [data-radix-scroll-area-viewport]`).first();
  await frame.evaluate((viewport) => {
    viewport.scrollLeft = viewport.scrollWidth;
  });
  await expect(page.getByTestId('doc-table-cell-button')).toBeHidden();

  await page.locator(TOP).first().click();
  await hoverCell(page, 'c8');
  const handle = await page.getByTestId('doc-table-row-handle').boundingBox();
  const box = await frame.boundingBox();
  expect(handle!.x + handle!.width).toBeGreaterThan(box!.x);
  expect(handle!.x).toBeLessThan(box!.x + 24);
});

test('A6 and A11: a cell cut by the frame of a wide table shows its button and column handle over its visible part', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 9);
  await fill(page, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  const frame = page.locator(`${EDITOR} [data-radix-scroll-area-viewport]`).first();
  const box = (await frame.boundingBox())!;
  const right = box.x + box.width;
  // The table scrolled until the frame's right edge runs through the middle of
  // the first cell it cuts; a point in that cell's visible half.
  const cut = await frame.evaluate((viewport, edge) => {
    for (const td of Array.from(viewport.querySelectorAll('tr:first-child td'))) {
      const r = td.getBoundingClientRect();
      if (r.right > edge) {
        viewport.scrollLeft += r.left + r.width / 2 - edge;
        const moved = td.getBoundingClientRect();
        return { x: moved.left + 8, y: moved.top + moved.height / 2 };
      }
    }
    return null;
  }, right);
  expect(cut).not.toBeNull();

  /**
   * Whether a control is shown, inside the frame.
   * @param testId - The control.
   * @returns Whether it is visible and within the frame.
   */
  const inFrame = async (testId: string): Promise<boolean> =>
    page.getByTestId(testId).evaluate((el, [left, edge]) => {
      if (getComputedStyle(el).visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.left >= left && r.right <= edge;
    }, [box.x, right] as const);

  // The scroll's event lands a frame later and hides the table's controls
  // (A6); the pointer arrives after it, as a reader's does.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.click(cut!.x, cut!.y);
  await expect(page.getByTestId('doc-table-cell-button')).toHaveCount(1);
  expect(await inFrame('doc-table-cell-button')).toBe(true);

  await page.mouse.move(cut!.x, cut!.y, { steps: 3 });
  await expect(page.getByTestId('doc-table-col-handle')).toHaveCount(1);
  expect(await inFrame('doc-table-col-handle')).toBe(true);

  // The whole button answers, its top edge too: nothing left where the
  // handle was before it moved takes the press.
  const button = (await page.getByTestId('doc-table-cell-button').boundingBox())!;
  await page.mouse.click(button.x + button.width / 2, button.y + 2);
  await expect(page.getByTestId('doc-table-cell-align')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-table-cell-align')).toHaveCount(0);
});

test('A21: a wide table shows an edge on each side that still has more to scroll', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 9);
  const frame = page.locator(`${EDITOR} [data-radix-scroll-area-viewport]`).first();

  /**
   * Which edges of the table frame are drawn, read off the page.
   * @returns Left and right, each whether it shows.
   */
  const edges = async (): Promise<{ left: boolean; right: boolean }> =>
    page.locator(`${EDITOR} [data-node-type='docTable']`).first().evaluate((block) => {
      const shown = (side: string): boolean => {
        const edge = block.querySelector(`[data-overflow-edge="${side}"]`);
        return edge !== null && getComputedStyle(edge).opacity === '1' && edge.getBoundingClientRect().width > 0;
      };
      return { left: shown('left'), right: shown('right') };
    });

  await expect.poll(edges).toEqual({ left: false, right: true });
  await frame.evaluate((viewport) => {
    viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
  });
  await expect.poll(edges).toEqual({ left: true, right: true });
  await frame.evaluate((viewport) => {
    viewport.scrollLeft = viewport.scrollWidth;
  });
  await expect.poll(edges).toEqual({ left: true, right: false });
});

test('A13: the table reads the product tokens in the dark theme', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await page.getByTestId('theme-toggle').click();
  await page.getByTestId('theme-option-dark').click();
  try {
    const read = await page.evaluate((selector) => {
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      probe.style.borderTop = '1px solid var(--color-border)';
      const border = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return { border, td: getComputedStyle(document.querySelector(`${selector} td`)!).borderTopColor };
    }, EDITOR);
    expect(read.td).toBe(read.border);
  } finally {
    await page.getByTestId('theme-toggle').click();
    await page.getByTestId('theme-option-system').click();
  }
});

test('A14 and T1: block shortcuts and block input rules work inside a cell, and the table stays', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await page.keyboard.press('ControlOrMeta+Alt+1');
  await page.keyboard.type('Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('---');
  await page.keyboard.type('item');
  await page.keyboard.press('ControlOrMeta+Shift+8');

  expect((await cellBlocks(page))[0][0]).toEqual(['heading:Title', 'divider', 'bulletListItem:item']);
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
  expect((await grids(page))[0][1]).toEqual(['', '']);
});

test('A15: Backspace over every cell of an empty table removes it, and undo brings it back', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await selectCells(page, 0, 3);
  await page.keyboard.press('Backspace');
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');

  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
});

test('A16: a table pasted from a spreadsheet lands as a table', async () => {
  await openFreshDocument(page);
  await page.keyboard.press('Enter');
  await page.evaluate((selector) => {
    const transfer = new DataTransfer();
    transfer.setData(
      'text/html',
      '<google-sheets-html-origin><table><tbody><tr><td>city</td><td>pop</td></tr><tr><td>Oslo</td><td>7</td></tr></tbody></table></google-sheets-html-origin>',
    );
    transfer.setData('text/plain', 'city\tpop\nOslo\t7');
    document.querySelector(selector)!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, EDITOR);

  expect(await grids(page)).toEqual([[['city', 'pop'], ['Oslo', '7']]]);
});

/**
 * Sends HTML and its text fallback through the browser's paste event.
 * @param p - The page holding the focused editor.
 * @param html - The clipboard's HTML.
 * @param text - Its text fallback.
 */
async function pasteHtml(p: Page, html: string, text: string): Promise<void> {
  await p.evaluate(({ selector, html, text }) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', html);
    transfer.setData('text/plain', text);
    document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { selector: EDITOR, html, text });
}

for (const theme of ['light', 'dark']) {
  test(`T14: a table pasted over a selection leaving a cell replaces the table in the body (${theme})`, async () => {
    await openFreshDocument(page);
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    await smallTable(page);
    await clickAndSettle(page, page.locator(TOP).nth(2));
    await page.keyboard.type('below');
    await selectInBody(page, () => page.evaluate((selector) => {
      const body = document.querySelector(selector)!;
      const from = Array.from(body.querySelectorAll('td .bn-inline-content')).find((node) => node.textContent === 'a1')!;
      const to = Array.from(body.querySelectorAll('.bn-inline-content')).find((node) => node.textContent === 'below')!;
      const range = document.createRange();
      // The whole-table selection keeps its start on the table's first word.
      range.setStart(from.firstChild!, 0);
      range.setEnd(to.firstChild!, 2);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, EDITOR));
    await expect(page.locator(`${EDITOR} td.doc-table-in-selection`)).toHaveCount(4);

    await pasteHtml(page, '<table><tr><td>new1</td><td>new2</td></tr></table>', 'new1\tnew2');

    await expect.poll(() => grids(page)).toEqual([[['new1', 'new2']]]);
    await expect(page.locator(`${EDITOR} > .bn-block-group > [data-node-type='docTable']`)).toHaveCount(1);
    await expect(page.locator(TOP).first()).toHaveText('lead');
    await expect(page.locator(TOP).filter({ hasText: /^low$/ })).toHaveCount(1);
  });
}

test('T1 and T9: a table pasted below a list in a cell becomes its blocks on both pages', async ({ browser }) => {
  const spaceId = await openFreshDocument(page);
  await smallTable(page);
  const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  other.on('pageerror', (error) => errors.push(String(error)));
  try {
    await other.goto(page.url());
    await other.getByTestId(`space-tab-name-${spaceId}`).click();
    await expect(other.locator(`${EDITOR} table`)).toHaveCount(1);
    await clickAndSettle(page, cell(page, 'a1'));
    await page.keyboard.press('End');

    await pasteHtml(page, '<ul><li>Outer<ul><li>Inner<table><tr><td>nested1</td><td>nested2</td></tr></table></li></ul></li></ul>', 'Outer\nInner\nnested1\tnested2');

    const expected = [[['a1OuterInnernested1nested2', 'b1'], ['a2', 'b2']]];
    await expect.poll(() => grids(page)).toEqual(expected);
    await expect.poll(() => grids(other)).toEqual(expected);
    await expect(page.locator(`${EDITOR} td table, ${EDITOR} th table`)).toHaveCount(0);
    await expect(other.locator(`${EDITOR} td table, ${EDITOR} th table`)).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('T6: dragging a whole table into a nested list in a cell leaves the document unchanged', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await clickAndSettle(page, cell(page, 'a1'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- item');
  await page.keyboard.press('Enter');
  await page.keyboard.type('nested');
  await page.keyboard.press('Tab');
  await insertTable(page, 1, 1);
  await page.keyboard.type('source');
  const before = await grids(page);
  const target = await page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^nested$/ }).boundingBox();
  expect(target).not.toBeNull();
  await page.evaluate(() => {
    const events = { starts: 0, drops: 0 };
    (window as unknown as { tableDropEvents: typeof events }).tableDropEvents = events;
    document.addEventListener('dragstart', () => { events.starts += 1; }, { capture: true });
    document.addEventListener('drop', () => { events.drops += 1; }, { capture: true });
  });
  await hoverTable(page);

  await dragHandle(page, page.getByTestId('doc-block-table-handle'), { x: target!.x + target!.width - 4, y: target!.y + target!.height / 2 });

  expect(await page.evaluate(() => (window as unknown as { tableDropEvents: { starts: number; drops: number } }).tableDropEvents)).toEqual({ starts: 1, drops: 1 });
  await expect.poll(() => grids(page)).toEqual(before);
  await expect(page.locator(`${EDITOR} td table, ${EDITOR} th table`)).toHaveCount(0);
});

test('A17: two pages on one Space end up with the same table', async ({ browser }) => {
  const spaceId = await openFreshDocument(page);
  await smallTable(page);
  const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  try {
    await other.goto(page.url());
    await other.getByTestId(`space-tab-name-${spaceId}`).click();
    await expect(other.locator(`${EDITOR} table`)).toHaveCount(1, { timeout: 20_000 });

    await clickAndSettle(page, cell(page, 'a2'));
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await hoverCell(other, 'a1');
    await other.getByTestId('doc-table-row-handle').click();
    await other.getByTestId('doc-table-row-insertAbove').click();

    const expected = [[['', ''], ['a1', 'b1'], ['a2!', 'b2']]];
    await expect.poll(() => grids(page)).toEqual(expected);
    await expect.poll(() => grids(other)).toEqual(expected);
  } finally {
    await other.close();
  }
});

/**
 * Opens the Space on a new page whose frames to collab can be held back, so
 * an edit there stays unseen by everyone until the case lets it go.
 * @param browser - The browser.
 * @param url - The project page.
 * @param spaceId - The Space.
 * @returns The page and the switch that holds or releases its frames.
 */
async function pageWithHeldFrames(
  browser: Browser,
  url: string,
  spaceId: string,
): Promise<{ p: Page; hold: (on: boolean) => void }> {
  const p = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  let held: (() => void)[] | null = null;
  await p.routeWebSocket('**/ws', (route) => {
    const server = route.connectToServer();
    route.onMessage((data) => {
      if (held === null) server.send(data);
      else held.push(() => server.send(data));
    });
  });
  await p.goto(url);
  await p.getByTestId(`space-tab-name-${spaceId}`).click();
  await expect(p.locator(`${EDITOR} table`)).toHaveCount(1, { timeout: 20_000 });
  const hold = (on: boolean): void => {
    if (on) {
      held ??= [];
      return;
    }
    const sends = held ?? [];
    held = null;
    for (const send of sends) send();
  };
  return { p, hold };
}

test('A17: a row and a column added at once leave one placeholder, and typing on both pages adds no columns', async ({ browser }) => {
  const spaceId = await openFreshDocument(page);
  await smallTable(page);
  const first = await pageWithHeldFrames(browser, page.url(), spaceId);
  const second = await pageWithHeldFrames(browser, page.url(), spaceId);
  try {
    first.hold(true);
    second.hold(true);
    await hoverCell(first.p, 'a2');
    await first.p.getByTestId('doc-table-row-handle').click();
    await first.p.getByTestId('doc-table-row-insertBelow').click();
    await hoverCell(second.p, 'b1');
    await second.p.getByTestId('doc-table-col-handle').click();
    await second.p.getByTestId('doc-table-col-insertRight').click();
    first.hold(false);
    second.hold(false);

    const shown = [[['a1', 'b1', ''], ['a2', 'b2', ''], ['', '', '']]];
    await expect.poll(() => grids(first.p)).toEqual(shown);
    await expect.poll(() => grids(second.p)).toEqual(shown);
    await expect(first.p.locator(`${EDITOR} [data-doc-table-missing]`)).toHaveCount(1);

    await clickAndSettle(first.p, cell(first.p, 'a1'));
    await first.p.keyboard.press('End');
    await clickAndSettle(second.p, cell(second.p, 'b2'));
    await second.p.keyboard.press('End');
    for (let round = 0; round < 3; round += 1) {
      first.hold(true);
      second.hold(true);
      await first.p.keyboard.type('x');
      await second.p.keyboard.type('y');
      first.hold(false);
      second.hold(false);
    }

    const typed = [[['a1xxx', 'b1', ''], ['a2', 'b2yyy', ''], ['', '', '']]];
    await expect.poll(() => grids(first.p)).toEqual(typed);
    await expect.poll(() => grids(second.p)).toEqual(typed);
    await expect.poll(() => grids(page)).toEqual(typed);
    await expect(page.locator(`${EDITOR} [data-doc-table-missing]`)).toHaveCount(1);
  } finally {
    await first.p.close();
    await second.p.close();
  }
});

test('T3 and T4: in a cell, Enter continues a list, Tab nests a list item before moving on, and Backspace at a cell\'s start stays in it', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await page.keyboard.press('ControlOrMeta+Shift+8');
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Tab');
  await expect(cell(page, 'onetwo').locator('[data-content-type="bulletListItem"] + .bn-block-group [data-content-type="bulletListItem"]')).toHaveText('two');
  // Nested as far as it goes: the next Tab moves on.
  await pressAndSettle(page, 'Tab');
  await page.keyboard.type('b');
  await pressAndSettle(page, 'Tab');
  // Nothing before the start of a cell to join: the caret stays where it is.
  await page.keyboard.press('Backspace');
  await page.keyboard.type('x');

  expect(await cellBlocks(page)).toEqual([
    [['bulletListItem:one', 'bulletListItem:two'], ['paragraph:b']],
    [['paragraph:x'], ['paragraph']],
  ]);
});

test('T5: deleting the only block of a one-cell table from its handle leaves the table and its cell', async () => {
  await openFreshDocument(page);
  await insertTable(page, 1, 1);
  await page.keyboard.type('only');
  const handle = await hoverWordsInCell(page, 'only');
  await handle.click();
  await page.getByTestId('doc-block-row-delete').click();

  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
  expect(await cellBlocks(page)).toEqual([[['paragraph']]]);
});

test('T6: the only block of a cell dragged out lands below the table and leaves an empty line in the cell', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await clickAndSettle(page, page.locator(TOP).nth(2));
  await page.keyboard.type('tail');
  const tail = await page.locator(TOP).nth(2).boundingBox();

  await dragHandle(page, await hoverWordsInCell(page, 'b1'), { x: tail!.x + 40, y: tail!.y + tail!.height - 2 });

  await expect(page.locator(TOP).nth(3)).toHaveText('b1');
  expect(await cellBlocks(page)).toEqual([
    [['paragraph:a1'], ['paragraph']],
    [['paragraph:a2'], ['paragraph:b2']],
  ]);
});

test('T6: a block dragged from one cell to another lands under the block it is dropped on', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  const b2 = await page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^b2$/ }).boundingBox();

  await dragHandle(page, await hoverWordsInCell(page, 'a2'), { x: b2!.x + b2!.width - 4, y: b2!.y + b2!.height - 2 });

  expect(await cellBlocks(page)).toEqual([
    [['paragraph:a1'], ['paragraph:b1']],
    [['paragraph'], ['paragraph:b2', 'paragraph:a2']],
  ]);
});

test('T6: a block dragged from the body into a cell lands in it', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await hoverRow(page, 0);
  const a1 = await page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^a1$/ }).boundingBox();

  await dragHandle(page, page.getByTestId('doc-block-handle'), { x: a1!.x + a1!.width - 4, y: a1!.y + a1!.height - 2 });

  expect(await cellBlocks(page)).toEqual([
    [['paragraph:a1', 'paragraph:lead'], ['paragraph:b1']],
    [['paragraph:a2'], ['paragraph:b2']],
  ]);
});

test('T7: a picture picked from the plus on an empty line in a narrow cell lands in that cell, no wider than it', async () => {
  await openFreshDocument(page);
  await insertTable(page, 1, 3);
  await page.keyboard.type('narrow');
  const cell = page.locator(`${EDITOR} td`).nth(1);
  const box = await cell.boundingBox();
  // Clear of the cell's top right corner, where the caret cell's button stands.
  await page.mouse.click(box!.x + 50, box!.y + box!.height / 2);
  await page.mouse.move(5, 5);
  await page.mouse.move(box!.x + 50, box!.y + box!.height / 2, { steps: 3 });
  await page.getByTestId('doc-block-plus').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('doc-block-insert-image').click();
  await (await chooser).setFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: readFileSync(resolve(__dirname, '../fixtures/portrait.png')),
  });

  const media = cell.locator('[data-content-type="image"] [data-media-box]');
  await expect(media).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(`${EDITOR} [data-content-type="image"]`)).toHaveCount(1);
  const sizes = await cell.evaluate((td) => {
    const style = getComputedStyle(td);
    return {
      inner: td.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      media: td.querySelector('[data-media-box]')!.getBoundingClientRect().width,
    };
  });
  expect(sizes.media).toBeGreaterThan(0);
  expect(sizes.media).toBeLessThanOrEqual(sizes.inner + 1);
});

test('T7: the toolbar of a picture in the first cell of a table stands whole over the page, past the table\'s edges', async () => {
  await openFreshDocument(page);
  await insertTable(page, 1, 3);
  const cell = page.locator(`${EDITOR} td`).first();
  const box = await cell.boundingBox();
  await page.mouse.click(box!.x + 50, box!.y + box!.height / 2);
  await page.mouse.move(5, 5);
  await page.mouse.move(box!.x + 50, box!.y + box!.height / 2, { steps: 3 });
  await page.getByTestId('doc-block-plus').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('doc-block-insert-image').click();
  await (await chooser).setFiles({
    name: 'portrait.png',
    mimeType: 'image/png',
    buffer: readFileSync(resolve(__dirname, '../fixtures/portrait.png')),
  });
  const media = cell.locator('[data-content-type="image"] [data-media-box]');
  await expect(media).toBeVisible({ timeout: 60_000 });

  await page.mouse.move(5, 5);
  const shown = await media.boundingBox();
  await page.mouse.move(shown!.x + shown!.width / 2, shown!.y + shown!.height / 2, { steps: 3 });
  const toolbar = page.getByTestId('doc-media-toolbar');
  await expect(toolbar).toHaveAttribute('data-shown', 'true');

  // Each corner of the toolbar is what the page shows at that point: nothing
  // clips it and nothing covers it.
  const corners = await toolbar.evaluate((bar) => {
    const r = bar.getBoundingClientRect();
    return [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]]
      .map(([x, y]) => bar.contains(document.elementFromPoint(x!, y!)));
  });
  expect(corners).toEqual([true, true, true, true]);

  // The pointer goes from the picture up onto the toolbar and it stays up to
  // be used.
  const remove = page.getByTestId('doc-media-delete');
  const target = await remove.boundingBox();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 6 });
  await expect(toolbar).toHaveAttribute('data-shown', 'true');
  await remove.click();
  await expect(page.locator(`${EDITOR} [data-content-type="image"]`)).toHaveCount(0);
});

test('T14: a selection run from a cell out of the table with the keyboard takes the whole table, and a typed key replaces it', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await clickAndSettle(page, page.locator(TOP).nth(2));
  await page.keyboard.type('below');
  // Past the undo manager's 500ms capture window, so the undo below takes
  // back the typed key alone and not the words put in just before it.
  await page.waitForTimeout(600);
  await cell(page, 'b2').click();

  await page.keyboard.press('Shift+ArrowDown');
  await expect(page.locator(`${EDITOR} td.doc-table-in-selection`)).toHaveCount(4);
  await page.keyboard.type('X');

  await expect(page.locator(`${EDITOR} [data-node-type='docTable']`)).toHaveCount(0);
  await expect(page.locator(TOP).first()).toHaveText('lead');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => grids(page)).toEqual([[['a1', 'b1'], ['a2', 'b2']]]);
});

test('T14: a mouse drag from a cell to below the table takes the whole table, and Backspace takes it away whole', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await clickAndSettle(page, page.locator(TOP).nth(2));
  await page.keyboard.type('below');
  const from = await page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^b1$/ }).boundingBox();
  const to = await page.locator(TOP).nth(2).boundingBox();

  await page.mouse.move(from!.x + 6, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(`${EDITOR} td.doc-table-in-selection`)).toHaveCount(4);
  await page.keyboard.press('Backspace');

  await expect(page.locator(`${EDITOR} [data-node-type='docTable']`)).toHaveCount(0);
  await expect(page.locator(TOP).first()).toHaveText('lead');
});

for (const key of ['Alt+Backspace', 'Enter']) {
  test(`T14: ${key} over a mouse drag from a cell to below the table takes the whole table away`, async () => {
    await openFreshDocument(page);
    await smallTable(page);
    await clickAndSettle(page, page.locator(TOP).nth(2));
    await page.keyboard.type('below words');
    const from = await page.locator(`${EDITOR} td .bn-inline-content`).filter({ hasText: /^b1$/ }).boundingBox();
    const to = await page.locator(TOP).nth(2).boundingBox();

    await page.mouse.move(from!.x + 6, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(`${EDITOR} td.doc-table-in-selection`)).toHaveCount(4);
    await page.keyboard.press(key);

    await expect(page.locator(`${EDITOR} [data-node-type='docTable']`)).toHaveCount(0);
    await expect(page.locator(TOP).first()).toHaveText('lead');
  });
}


for (const { type, chord, key } of [
  { type: 'heading', chord: 'ControlOrMeta+Alt+1', key: 'Backspace' },
  { type: 'codeBlock', chord: 'ControlOrMeta+Alt+c', key: 'Delete' },
]) {
  test(`T5: ${key} clears selected cells with an empty ${type}, and undo restores it`, async () => {
    await openFreshDocument(page);
    await insertTable(page, 2, 2);
    await page.keyboard.press(chord);
    await expect(page.locator(`${EDITOR} td [data-content-type="${type}"]`)).toHaveCount(1);
    await pressAndSettle(page, 'Tab');
    await page.keyboard.press(chord);
    await expect(page.locator(`${EDITOR} td [data-content-type="${type}"]`)).toHaveCount(2);
    await page.waitForTimeout(600);
    await selectCells(page, 0, 3);

    await page.keyboard.press(key);

    await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);
    expect(await cellBlocks(page)).toEqual([[['paragraph'], ['paragraph']], [['paragraph'], ['paragraph']]]);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(`${EDITOR} td [data-content-type="${type}"]`)).toHaveCount(2);
    await expect(page.locator(`${EDITOR} td`)).toHaveCount(4);
  });
}

test('T5: merging an empty heading with a paragraph keeps both blocks', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await page.keyboard.press('ControlOrMeta+Alt+1');
  await expect(page.locator(`${EDITOR} td [data-content-type="heading"]`)).toHaveCount(1);
  await pressAndSettle(page, 'Tab');
  await page.keyboard.type('B');
  await selectCells(page, 0, 1);

  await page.getByTestId('doc-bubble-tool-mergeCells').click();

  expect((await cellBlocks(page))[0]).toEqual([['heading', 'paragraph:B']]);
});

for (const theme of ['light', 'dark']) {
  for (const header of [false, true]) {
    test(`T7: video display and column resizing respect a narrow ${header ? 'header' : 'ordinary'} cell (${theme}) @needs-ingest @needs-storage`, async ({ browser }) => {
      await openFreshDocument(page);
      await page.getByTestId('theme-toggle').click();
      await page.getByTestId(`theme-option-${theme}`).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await insertTable(page, 1, 3);
      await page.keyboard.type('narrow');
      if (header) {
        await hoverCell(page, 'narrow');
        await page.getByTestId('doc-table-row-handle').click();
        await page.getByTestId('doc-table-row-header').click();
        await expect(page.locator(`${EDITOR} th`)).toHaveCount(3);
      }
      const target = page.locator(`${EDITOR} ${header ? 'th' : 'td'}`).nth(1);
      const initial = await target.boundingBox();
      if (initial === null) throw new Error('missing target cell');
      await page.mouse.click(initial.x + 50, initial.y + initial.height / 2);
      await page.mouse.move(5, 5);
      await page.mouse.move(initial.x + 50, initial.y + initial.height / 2, { steps: 3 });
      await page.getByTestId('doc-block-plus').click();
      await roomForUploads(1);
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('doc-block-insert-video').click();
      await (await chooser).setFiles({
        name: 'cell-video.mp4', mimeType: 'video/mp4',
        buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
      });
      const media = target.locator('[data-content-type="video"] [data-media-box]');
      await expect(media).toBeVisible({ timeout: 60_000 });
      expect((await target.boundingBox())!.width).toBeLessThanOrEqual(initial.width + 1);
      await clickAndSettle(page, page.locator(TOP).first());
      const video = media.getByTestId('media-element');
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(1);
      await video.evaluate((element: HTMLVideoElement) => {
        const player = element.closest('[data-testid="media-player"]')!;
        (window as unknown as { tableVideoNodes: { video: Element; seek: Element; controls: Element } }).tableVideoNodes = {
          video: element, seek: player.querySelector('[data-testid="seek"]')!, controls: player.querySelector('[data-testid="controls"]')!,
        };
        element.volume = 0.4;
        element.muted = true;
      });
      for (const desired of [240, 140, 120, 80, 35]) {
        await resizeDocumentColumn(page, target, desired);
        const sizes = await target.evaluate((td) => {
          const style = getComputedStyle(td);
          const media = td.querySelector('[data-media-box]')!;
          return {
            cell: td.getBoundingClientRect().width,
            content: td.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            media: media.getBoundingClientRect().width,
          };
        });
        expect(sizes.cell).toBeLessThanOrEqual(desired + 1);
        expect(sizes.media).toBeGreaterThan(0);
        expect(sizes.media).toBeLessThanOrEqual(sizes.content + 1);
        const floating = sizes.media < 128;
        await expect(media).toHaveAttribute('data-controls-mode', floating ? 'floating' : 'inline');
        const bodyHeight = await page.locator(EDITOR).evaluate((element) => element.getBoundingClientRect().height);
        if (floating) {
          await media.getByTestId('doc-media-video-trigger').focus();
          await page.keyboard.press('Enter');
          await expect(page.getByTestId('doc-media-video-panel')).toBeFocused();
          await page.keyboard.press('Tab');
          await expect(page.getByTestId('doc-media-video-panel').getByTestId('doc-media-caption-button')).toBeFocused();
          await expect.poll(() => page.getByTestId('doc-media-video-panel').evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
        }
        const controls = floating ? page.getByTestId('doc-media-video-panel').getByTestId('controls') : media.getByTestId('controls');
        const seek = controls.getByTestId('seek');
        const seekBox = await seek.boundingBox();
        expect(seekBox!.width).toBeGreaterThanOrEqual(40);
        await seek.click({ position: { x: seekBox!.width * 0.75, y: seekBox!.height / 2 } });
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime / element.duration)).toBeCloseTo(0.75, 1);
        const identity = await video.evaluate((element: HTMLVideoElement) => {
          const saved = (window as unknown as { tableVideoNodes: { video: Element; seek: Element; controls: Element } }).tableVideoNodes;
          return { video: saved.video === element, volume: element.volume, muted: element.muted, paused: element.paused };
        });
        const controlIdentity = await controls.evaluate((element) => {
          const saved = (window as unknown as { tableVideoNodes: { seek: Element; controls: Element } }).tableVideoNodes;
          return { seek: saved.seek === element.querySelector('[data-testid="seek"]'), controls: saved.controls === element };
        });
        expect({ ...identity, ...controlIdentity }).toEqual({ video: true, seek: true, controls: true, volume: 0.4, muted: true, paused: true });
        if (floating) {
          const actions = (await page.getByTestId('doc-media-video-panel').getByTestId('doc-media-toolbar').boundingBox())!;
          const transport = (await controls.boundingBox())!;
          const panel = (await page.getByTestId('doc-media-video-panel').boundingBox())!;
          expect(transport.x).toBeGreaterThanOrEqual(panel.x + 1);
          expect(transport.x + transport.width).toBeLessThanOrEqual(panel.x + panel.width - 1);
          const fullscreen = (await controls.getByTestId('fullscreen').boundingBox())!;
          expect(fullscreen.x + fullscreen.width).toBeLessThanOrEqual(panel.x + panel.width - 1);
          expect(actions.y + actions.height).toBeLessThanOrEqual(transport.y);
          expect(await page.locator(EDITOR).evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(bodyHeight, 1);
          await expect(page.getByRole('tooltip')).toHaveCount(0);
          await page.keyboard.press('Escape');
          await expect(media.getByTestId('doc-media-video-trigger')).toBeFocused();
          await expect(page.getByTestId('doc-media-video-panel')).toHaveCount(0);
        } else {
          const transport = (await controls.boundingBox())!;
          const picture = (await video.boundingBox())!;
          expect(transport.y + transport.height).toBeCloseTo(picture.y + picture.height, 1);
        }
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await test.info().attach(`cell-video-${desired}`, { body: JSON.stringify({ theme, header, desired, ...sizes, seek: seekBox!.width }), contentType: 'application/json' });
      }
      const spaceId = await visibleSpace(page).getByTestId('document-space').getAttribute('data-space-id');
      const peer = await browser.newPage({ storageState: stateFile('A'), viewport: { width: 1680, height: 950 } });
      try {
        await peer.goto(page.url());
        await peer.getByTestId(`space-tab-name-${String(spaceId)}`).click();
        const peerCell = peer.locator(`${EDITOR} ${header ? 'th' : 'td'}`).nth(1);
        await expect(peerCell.locator('video')).toBeVisible();
        for (const [fromWidth, toWidth] of [[240, 80], [80, 240], [240, 180]] as const) {
          await resizeDocumentColumn(peer, peerCell, fromWidth);
          await expect.poll(async () => Math.abs((await target.boundingBox())!.width - fromWidth)).toBeLessThanOrEqual(1);
          const floating = (await media.boundingBox())!.width < 128;
          await expect(media).toHaveAttribute('data-controls-mode', floating ? 'floating' : 'inline');
          if (floating) {
            await media.getByTestId('doc-media-video-trigger').focus();
            await page.keyboard.press('Enter');
          }
          const activeSeek = page.locator('[data-testid="seek"]:visible');
          await expect(activeSeek).toHaveCount(1);
          await activeSeek.evaluate((element) => {
            element.addEventListener('pointerdown', (event) => {
              (window as unknown as { tablePointer: number }).tablePointer = (event as PointerEvent).pointerId;
            }, { once: true });
          });
          const before = (await activeSeek.boundingBox())!;
          await page.mouse.move(before.x + before.width * 0.3, before.y + before.height / 2);
          await page.mouse.down();
          await expect.poll(() => activeSeek.evaluate((element) => element.hasPointerCapture((window as unknown as { tablePointer: number }).tablePointer))).toBe(true);
          await resizeDocumentColumn(peer, peerCell, toWidth);
          await expect.poll(async () => Math.abs((await target.boundingBox())!.width - toWidth)).toBeLessThanOrEqual(1);
          const movedSeek = page.locator('[data-testid="seek"]:visible');
          await expect(movedSeek).toHaveCount(1);
          const after = (await movedSeek.boundingBox())!;
          await page.mouse.move(after.x + after.width * 0.75, after.y + after.height / 2, { steps: 3 });
          await page.mouse.up();
          await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime / element.duration)).toBeCloseTo(0.75, 1);
          expect(await movedSeek.evaluate((element) => (window as unknown as { tableVideoNodes: { seek: Element } }).tableVideoNodes.seek === element)).toBe(true);
          await page.keyboard.press('Escape');
        }
        const playableSeek = page.locator('[data-testid="seek"]:visible');
        await playableSeek.getByRole('slider').focus();
        await page.keyboard.press('Home');
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBe(0);
        await page.locator('[data-testid="play-toggle"]:visible').click();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
        for (const width of [80, 240]) {
          await resizeDocumentColumn(peer, peerCell, width);
          await expect.poll(async () => Math.abs((await target.boundingBox())!.width - width)).toBeLessThanOrEqual(1);
          await expect(page.locator('[data-testid="play-toggle"]:visible')).toBeFocused();
          expect(await video.evaluate((element: HTMLVideoElement) => {
            const saved = (window as unknown as { tableVideoNodes: { video: Element } }).tableVideoNodes;
            return { same: element === saved.video, paused: element.paused, volume: element.volume, muted: element.muted };
          })).toEqual({ same: true, paused: false, volume: 0.4, muted: true });
        }
        await page.locator('[data-testid="play-toggle"]:visible').click();
        expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
      } finally {
        await page.mouse.up();
        await peer.close();
      }
      await resizeDocumentColumn(page, target, 80);
      for (const code of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
        await page.getByTestId('lang-trigger').click();
        await page.getByTestId(`lang-option-${code}`).click();
        await expect(page.getByTestId('lang-popover')).toHaveCount(0);
        await media.getByTestId('doc-media-video-trigger').focus();
        await page.keyboard.press('Enter');
        const panel = page.getByTestId('doc-media-video-panel');
        await expect(panel).toBeVisible();
        await panel.getByTestId('doc-media-caption-button').hover();
        const catalog = JSON.parse(readFileSync(resolve(__dirname, `../../../../locales/${code}.json`), 'utf8')) as { spaces: { document: { media: { caption: string } } } };
        await expect(page.getByRole('tooltip')).toHaveText(catalog.spaces.document.media.caption);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
      }
      await page.getByTestId('lang-trigger').click();
      await page.getByTestId('lang-option-en').click();
      await expect(page.getByTestId('lang-popover')).toHaveCount(0);
      await media.getByTestId('doc-media-video-trigger').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('doc-media-video-panel')).toBeVisible();
      await expect.poll(() => page.getByTestId('doc-media-video-panel').evaluate((element) => getComputedStyle(element).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
      const screenshot = test.info().outputPath(`narrow-video-${theme}-${header ? 'header' : 'ordinary'}.png`);
      await page.screenshot({ path: screenshot });
      await test.info().attach('narrow-video', { path: screenshot, contentType: 'image/png' });
      const beforeDownload = await video.evaluate((element: HTMLVideoElement) => ({ time: element.currentTime, paused: element.paused, volume: element.volume, muted: element.muted }));
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('doc-media-video-panel').getByTestId('doc-media-download').click(),
      ]);
      expect(readFileSync(await download.path()).equals(readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')))).toBe(true);
      expect(await video.evaluate((element: HTMLVideoElement) => ({ time: element.currentTime, paused: element.paused, volume: element.volume, muted: element.muted }))).toEqual(beforeDownload);
      await expect(page.getByTestId('doc-media-video-panel')).toBeVisible();
      try {
        await page.getByTestId('doc-media-video-panel').getByTestId('fullscreen').click();
        await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('VIDEO');
      } finally {
        await page.evaluate(async () => { if (document.fullscreenElement !== null) await document.exitFullscreen(); });
      }
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
      await media.getByTestId('doc-media-video-trigger').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('doc-media-video-panel')).toBeVisible();
      await page.keyboard.press('Escape');
      if (theme === 'light' && !header) {
        const activePanel = page.locator('[data-testid="doc-media-video-panel"][data-state="open"]');
        await media.getByTestId('doc-media-frame').hover();
        await page.getByTestId('doc-block-handle').click();
        await page.getByTestId('doc-block-row-duplicate').click();
        const entries = target.getByTestId('doc-media-video-trigger');
        await expect(entries).toHaveCount(2);
        await entries.first().focus();
        await page.keyboard.press('Enter');
        await expect(activePanel).toHaveCount(1);
        await expect(activePanel).toBeFocused();
        await entries.nth(1).focus();
        await page.keyboard.press('Enter');
        await expect(activePanel).toHaveCount(1);
        await expect(activePanel).toBeFocused();
        await activePanel.getByTestId('play-toggle').click();
        await expect.poll(() => target.locator('video').nth(1).evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
        expect(await target.locator('video').first().evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
        await activePanel.getByTestId('play-toggle').click();
        await page.keyboard.press('Escape');
        await clickAndSettle(page, page.locator(TOP).first());
        await target.getByTestId('doc-media-frame').first().hover();
        await expect(activePanel).toBeVisible();
        await activePanel.hover();
        await expect(activePanel).toBeVisible();
        await page.mouse.move(5, 5);
        await expect(page.getByTestId('doc-media-video-panel')).toHaveCount(0);

        await clickAndSettle(page, page.locator(TOP).last());
        await pasteHtml(page, '<p>scroll line</p>'.repeat(40), 'scroll line\n'.repeat(40));
        await entries.first().focus();
        await page.keyboard.press('Enter');
        await expect(activePanel).toBeFocused();
        await page.mouse.move(5, 5);
        await page.getByTestId('document-editor-content').evaluate((element) => {
          const viewport = element.closest('[data-radix-scroll-area-viewport]')!;
          viewport.scrollTo({ top: viewport.scrollHeight });
        });
        await expect.poll(() => entries.first().evaluate((element) => {
          const viewport = document.querySelector('[data-testid="document-editor-content"]')!.closest('[data-radix-scroll-area-viewport]')!;
          return element.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().top;
        })).toBe(true);
        await expect(page.getByTestId('doc-media-video-panel')).toHaveCount(0);
        await page.getByTestId('document-editor-content').evaluate((element) => element.closest('[data-radix-scroll-area-viewport]')!.scrollTo({ top: 0 }));
        await entries.first().focus();
        await page.keyboard.press('Enter');
        await activePanel.getByTestId('play-toggle').click();
        const playing = await target.locator('video').first().elementHandle();
        await expect.poll(() => playing!.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
        await page.locator('[data-testid^="space-tab-name-"]').filter({ hasText: /^Canvas$/ }).click();
        await expect(page.getByTestId('doc-media-video-panel')).toBeHidden();
        await expect.poll(() => playing!.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
        await page.getByTestId(`space-tab-name-${String(spaceId)}`).click();
        await expect(entries.first()).toBeVisible();
        await expect(page.getByTestId('doc-media-video-panel')).toHaveCount(0);
        expect(await target.locator('video').first().evaluate((element) => (window as unknown as { tableVideoNodes: { video: Element } }).tableVideoNodes.video === element)).toBe(true);
      }
    });
  }
}
