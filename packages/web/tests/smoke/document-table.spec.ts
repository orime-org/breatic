// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Tables in a document, end to end (inner#1126).
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
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { pressAndSettle } from '../helpers/editor-keys';
import { createSpace, deleteSpace } from '../helpers/space';

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

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const TOP = `${EDITOR} > .bn-block-group > .bn-block-outer > .bn-block > .bn-block-content`;

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
  await p.mouse.move(a.x + 10, a.y + a.height / 2);
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

test('A3: words in a cell take styles there only, and Enter breaks the line inside it', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  for (let i = 0; i < 'two'.length; i += 1) await pressAndSettle(page, 'Shift+ArrowLeft');
  await page.keyboard.press('ControlOrMeta+b');

  const first = cell(page, 'onetwo');
  await expect(first.locator('br')).toHaveCount(1);
  await expect(first.locator('strong')).toHaveText('two');
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
  await hoverRow(page, 1);
  const entry = page.getByTestId('doc-block-table-handle');
  await expect(entry).toBeVisible();
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
    'doc-block-row-delete',
  ]);
  await page.keyboard.press('Escape');

  // A line under the table to drop it below.
  await page.locator(TOP).nth(2).click();
  await page.keyboard.type('tail');
  await hoverRow(page, 1);
  const handle = await page.getByTestId('doc-block-table-handle').boundingBox();
  const tail = await page.locator(TOP).nth(2).boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 8, handle!.y + 12, { steps: 4 });
  await page.mouse.move(tail!.x + 40, tail!.y + tail!.height - 2, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(TOP).nth(1)).toHaveText('tail');
  await expect(page.locator(TOP).nth(2).locator('table')).toHaveCount(1);
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
  await expect(page.getByTestId('doc-bubble-block-type')).toBeDisabled();
  await page.getByTestId('doc-bubble-tool-mergeCells').click();
  await expect(page.locator(`${EDITOR} tr`).first().locator('td')).toHaveCount(1);
  expect((await grids(page))[0]![0]).toEqual(['a1b1']);

  await cell(page, 'a1b1').click();
  await page.getByTestId('doc-table-cell-button').click();
  await page.getByTestId('doc-table-cell-split').click();
  await expect(page.locator(`${EDITOR} tr`).first().locator('td')).toHaveCount(2);
});

test('A11: the cell button is on the caret cell only, and aligns that cell', async () => {
  await openFreshDocument(page);
  await smallTable(page);
  await expect(page.getByTestId('doc-table-cell-button')).toHaveCount(0);

  await cell(page, 'b2').click();
  const button = await page.getByTestId('doc-table-cell-button').boundingBox();
  const b2 = await cell(page, 'b2').boundingBox();
  expect(button!.x + button!.width).toBeLessThanOrEqual(b2!.x + b2!.width);
  expect(button!.y).toBeGreaterThanOrEqual(b2!.y);
  await page.getByTestId('doc-table-cell-button').click();
  await expect(page.getByTestId('doc-table-cell-split')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('doc-table-cell-align').hover();
  await page.getByTestId('doc-table-cell-align-center').click();

  const aligned = await page.locator(`${EDITOR} td`).evaluateAll((tds) =>
    tds.map((td) => getComputedStyle(td.firstElementChild ?? td).textAlign),
  );
  expect(aligned.filter((a) => a === 'center')).toHaveLength(1);

  // The cell was redrawn with its new alignment; the button stays on it.
  await expect(page.getByTestId('doc-table-cell-button')).toBeVisible();
  const again = await page.getByTestId('doc-table-cell-button').boundingBox();
  const redrawn = await cell(page, 'b2').boundingBox();
  expect(again!.x + again!.width).toBeLessThanOrEqual(redrawn!.x + redrawn!.width);
  expect(again!.x).toBeGreaterThanOrEqual(redrawn!.x);
  expect(again!.y).toBeGreaterThanOrEqual(redrawn!.y);
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

test('A6, A11 and A12: on a wide table scrolled sideways, the row handle stays in the frame and the cell button leaves with its cell', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 9);
  await fill(page, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  // The caret in the first cell, then the table scrolled until that cell is out of sight.
  await cell(page, 'c1').click();
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

test('A14: block shortcuts and block input rules inside a cell leave the table as it is', async () => {
  await openFreshDocument(page);
  await insertTable(page, 2, 2);
  await page.keyboard.press('ControlOrMeta+Alt+1');
  await page.keyboard.type('---');
  await page.keyboard.press('ControlOrMeta+Shift+8');

  expect(await grids(page)).toEqual([[['---', ''], ['', '']]]);
  await expect(page.locator(`${EDITOR} hr, ${EDITOR} h1, ${EDITOR} ul`)).toHaveCount(0);
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

test('A17: two pages on one Space end up with the same table', async ({ browser }) => {
  const spaceId = await openFreshDocument(page);
  await smallTable(page);
  const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  try {
    await other.goto(page.url());
    await other.getByTestId(`space-tab-name-${spaceId}`).click();
    await expect(other.locator(`${EDITOR} table`)).toHaveCount(1, { timeout: 20_000 });

    await cell(page, 'a2').click();
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
