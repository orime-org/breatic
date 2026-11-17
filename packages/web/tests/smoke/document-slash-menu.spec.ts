// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The slash menu in the document body end to end (inner#1125).
 *
 * What jsdom cannot show: the menu opening under the real caret from real
 * typing, a real input method committing the ideographic comma, the real
 * Cmd/Ctrl+Z after a pick, the formula box taking focus, the size grid's
 * pick, a code block and a table cell as the browser lays them out, and a
 * click away from the menu.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { switchLanguage } from '../helpers/language';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

let page: Page;

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

/** The open slash menu. */
const MENU = '[data-testid="doc-slash-menu"]';

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 */
async function openFreshDocument(p: Page): Promise<void> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `slash-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
}

/**
 * Every text row as `type:text` (a heading as `heading2:text`, a quoted row
 * with a leading `>`), and a formula block or table by its type, read off the
 * editor's document.
 * @param p - The page.
 * @returns One entry per row.
 */
async function lines(p: Page): Promise<string[]> {
  return p.evaluate((selector) => {
    type PMNode = {
      type: { name: string };
      attrs: Record<string, unknown>;
      isTextblock: boolean;
      textContent: string;
      descendants: (fn: (node: PMNode) => boolean | void) => void;
    };
    const view = document.querySelector(selector) as unknown as { editor?: { state: { doc: PMNode } } } | null;
    if (view?.editor === undefined) return [];
    const out: string[] = [];
    view.editor.state.doc.descendants((node) => {
      if (node.type.name === 'mathBlock' || node.type.name === 'docTable') {
        out.push(node.type.name);
        return false;
      }
      if (!node.isTextblock) return true;
      const level = node.type.name === 'heading' ? String(node.attrs['level']) : '';
      const quoted = node.attrs['quoted'] === true ? '>' : '';
      out.push(`${quoted}${node.type.name}${level}:${node.textContent}`);
      return false;
    });
    return out;
  }, EDITOR);
}

/**
 * Rests the pointer on the Table row, then moves it diagonally to a cell of
 * the size grid, across the rows below Table.
 * @param p - The page.
 * @param cell - The cell's test id.
 */
async function crossToCell(p: Page, cell: string): Promise<void> {
  const table = await p.getByTestId('doc-slash-row-table').boundingBox();
  await p.mouse.move(table!.x + 20, table!.y + table!.height / 2, { steps: 4 });
  const target = p.getByTestId(cell);
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  await p.mouse.move(box!.x + 4, box!.y + 4, { steps: 25 });
}

/**
 * The ids of the rows the menu lists, top to bottom.
 * @param p - The page.
 * @returns The row ids.
 */
async function rowIds(p: Page): Promise<string[]> {
  return p
    .locator(`${MENU} [data-testid^="doc-slash-row-"]`)
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.slice('doc-slash-row-'.length)));
}

test.describe('the slash menu in the document body', () => {
  test('opens at a line start, picks with the arrows and Enter, and one undo brings the query back', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/head');
    const menu = page.locator(MENU);
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('doc-slash-row-heading-1')).toHaveAttribute('data-highlighted', '');

    const caret = await page.evaluate(() => window.getSelection()?.getRangeAt(0).getBoundingClientRect().bottom ?? 0);
    const top = (await menu.boundingBox())?.y ?? 0;
    expect(top).toBeGreaterThanOrEqual(caret);

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('doc-slash-row-heading-2')).toHaveAttribute('data-highlighted', '');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect.poll(() => lines(page)).toEqual(['heading2:']);
    await expect(page.locator(EDITOR)).toBeFocused();

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => lines(page)).toEqual(['paragraph:/head']);
  });

  test('stays shut inside a word and puts the pick below a line with text', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('abc/');
    await expect(page.locator(MENU)).toBeHidden();
    await page.keyboard.type(' /quo');
    await expect(page.locator(MENU)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => lines(page)).toEqual(['paragraph:abc/ ', '>paragraph:']);
  });

  test('says nothing matches, then closes; Esc and a click away close it with the text kept', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/zzz');
    await expect(page.getByTestId('doc-slash-empty')).toBeVisible();
    await page.keyboard.type('z');
    await expect(page.locator(MENU)).toBeHidden();

    await page.keyboard.press('Enter');
    await page.keyboard.type('/he');
    await expect(page.locator(MENU)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).toBeHidden();

    await page.keyboard.press('Enter');
    await page.keyboard.type('/he');
    await expect(page.locator(MENU)).toBeVisible();
    await page.locator(EDITOR).click({ position: { x: 5, y: 5 } });
    await expect(page.locator(MENU)).toBeHidden();
    await expect.poll(() => lines(page)).toEqual(['paragraph:/zzzz', 'paragraph:/he', 'paragraph:/he']);
  });

  test('opens the formula box as the plus menu does', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/formula');
    await page.keyboard.press('Enter');
    await expect(page.locator(`${EDITOR} .doc-math[data-open="true"] [data-formula-box] textarea`)).toBeFocused();
    await expect.poll(() => lines(page)).toEqual(['mathBlock']);
  });

  test('opens the size grid and puts a table of the size picked', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-slash-table-grid')).toBeVisible();
    await page.getByTestId('doc-slash-table-size-2-3').click();
    await expect(page.locator(MENU)).toBeHidden();
    await expect.poll(() => lines(page)).toContain('docTable');
    const shape = await page.evaluate((selector) => {
      const table = document.querySelector(`${selector} table`);
      return table === null ? null : [table.querySelectorAll('tr').length, table.querySelector('tr')?.children.length ?? 0];
    }, EDITOR);
    expect(shape).toEqual([2, 3]);
  });

  test('stays shut in a code block', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/code');
    await page.keyboard.press('Enter');
    await expect.poll(() => lines(page)).toEqual(['codeBlock:']);
    await page.keyboard.type('/');
    await expect.poll(() => lines(page)).toEqual(['codeBlock:/']);
    await expect(page.locator(MENU)).toBeHidden();
  });

  test('greys Table on a line in a table cell', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');
    await page.getByTestId('doc-slash-table-size-2-2').click();
    await expect.poll(() => lines(page)).toContain('docTable');
    await page.keyboard.type('/');
    await expect(page.locator(MENU)).toBeVisible();
    await expect(page.getByTestId('doc-slash-row-table')).toHaveAttribute('aria-disabled', 'true');
  });

  test('opens on an ideographic comma committed by an input method', async () => {
    await openFreshDocument(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '、', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '、' });
    await expect(page.locator(MENU)).toBeVisible();
    await expect.poll(() => lines(page)).toEqual(['paragraph:、']);
    await page.keyboard.press('Escape');
    await expect(page.locator(MENU)).toBeHidden();
    await expect.poll(() => lines(page)).toEqual(['paragraph:、']);
  });

  test('keeps the size grid open while the pointer crosses the rows below Table toward it', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/');
    const table = await page.getByTestId('doc-slash-row-table').boundingBox();
    expect(table).not.toBeNull();
    await page.mouse.move(table!.x + 20, table!.y + table!.height / 2);
    const far = page.getByTestId('doc-slash-table-size-6-6');
    await expect(far).toBeVisible();
    const cell = await far.boundingBox();
    await page.mouse.move(cell!.x + 5, cell!.y + 5, { steps: 25 });
    await expect(page.getByTestId('doc-slash-table-grid')).toBeVisible();
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => lines(page)).toContain('docTable');
  });

  test('keeps a grid opened from the keyboard open while the pointer crosses the rows toward it', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/');
    const table = page.getByTestId('doc-slash-row-table');
    for (let step = 0; step < 20 && (await table.getAttribute('data-highlighted')) === null; step += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('ArrowRight');
    const grid = page.getByTestId('doc-slash-table-grid');
    await expect(grid).toBeVisible();
    await crossToCell(page, 'doc-slash-table-size-6-6');
    await expect(grid).toBeVisible();
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => lines(page)).toContain('docTable');
  });

  test('keeps the grace on a second trip from Table to the grid', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/');
    const grid = page.getByTestId('doc-slash-table-grid');
    await crossToCell(page, 'doc-slash-table-size-2-2');
    await expect(grid).toBeVisible();
    const box = await grid.boundingBox();
    await page.mouse.move(box!.x + box!.width + 15, box!.y + 10, { steps: 5 });
    await crossToCell(page, 'doc-slash-table-size-6-6');
    await expect(grid).toBeVisible();
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => lines(page)).toContain('docTable');
  });

  test('keeps the keyboard highlight when the list scrolls under a pointer that has not moved', async () => {
    await page.setViewportSize({ width: 1680, height: 640 });
    await openFreshDocument(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    const list = page.locator(`${MENU} [data-radix-scroll-area-viewport]`);
    const row = await page.getByTestId('doc-slash-row-heading-2').boundingBox();
    await page.mouse.move(row!.x + 30, row!.y + row!.height / 2);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    // The list has to have scrolled for a row to pass under the pointer.
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByTestId('doc-slash-row-video')).toHaveAttribute('data-highlighted', '');
    await page.waitForTimeout(300);
    await expect(page.getByTestId('doc-slash-row-video')).toHaveAttribute('data-highlighted', '');
    await expect(page.getByTestId('doc-slash-table-grid')).toHaveCount(0);
  });

  test('keeps the size grid open when the pointer leaves it sideways, as the insert menu does', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/');
    const table = await page.getByTestId('doc-slash-row-table').boundingBox();
    await page.mouse.move(table!.x + 20, table!.y + table!.height / 2);
    const grid = page.getByTestId('doc-slash-table-grid');
    await expect(grid).toBeVisible();
    const cell = await page.getByTestId('doc-slash-table-size-3-3').boundingBox();
    await page.mouse.move(cell!.x + 4, cell!.y + 4, { steps: 8 });
    const box = await grid.boundingBox();
    await page.mouse.move(box!.x + box!.width + 15, cell!.y + 4, { steps: 5 });
    await page.waitForTimeout(400);
    await expect(grid).toBeVisible();
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe('');
  });

  test('stays under the trigger when the window narrows', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('x /');
    await expect(page.locator(MENU)).toBeVisible();
    await page.setViewportSize({ width: 760, height: 950 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const trigger = document.querySelector('.bn-suggestion-decorator')?.getBoundingClientRect();
          const menu = document.querySelector('[data-testid="doc-slash-menu"]')?.getBoundingClientRect();
          return trigger === undefined || menu === undefined ? null : Math.abs(Math.round(menu.left - trigger.left));
        }),
      )
      .toBe(0);
  });

  test('takes a trigger committed after a pause out with one undo', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('ab ');
    // What was typed before stays its own undo step.
    await page.waitForTimeout(900);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '\u3001', selectionStart: 1, selectionEnd: 1 });
    // A pause longer than the undo history's grouping window.
    await page.waitForTimeout(800);
    await cdp.send('Input.insertText', { text: '\u3001' });
    await expect(page.locator(MENU)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => lines(page)).toEqual(['paragraph:ab ']);
  });

  test('turns an empty list item into the pick in place', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('- ');
    await expect.poll(() => lines(page)).toEqual(['bulletListItem:']);
    await page.keyboard.type('/head');
    await expect(page.locator(MENU)).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => lines(page)).toEqual(['heading1:']);
  });

  test('keeps the list through a pinyin composition and narrows it by the Chinese name it commits', async () => {
    await openFreshDocument(page);
    await switchLanguage(page, 'zh-CN');
    try {
      await page.locator(EDITOR).click();
      await page.keyboard.type('/');
      await expect(page.locator(MENU)).toBeVisible();
      const all = await rowIds(page);
      const cdp = await page.context().newCDPSession(page);
      for (const text of ['b', 'bi', 'bia', 'biao']) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
      }
      await expect(page.locator(MENU)).toBeVisible();
      expect(await rowIds(page)).toEqual(all);
      await cdp.send('Input.insertText', { text: '表格' });
      await expect.poll(() => rowIds(page)).toEqual(['table']);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('doc-slash-table-grid')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.locator(MENU)).toBeHidden();
      await expect.poll(() => lines(page)).toEqual(['paragraph:/表格']);
    } finally {
      await switchLanguage(page, 'en');
    }
  });

  test('stays open while the list is scrolled by dragging its scrollbar', async () => {
    await page.setViewportSize({ width: 1680, height: 640 });
    await openFreshDocument(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    const list = page.locator(`${MENU} [data-radix-scroll-area-viewport]`);
    const box = await list.boundingBox();
    await page.mouse.move(box!.x + box!.width - 4, box!.y + 10, { steps: 3 });
    const bar = page.locator(`${MENU} [data-radix-scroll-area-viewport] ~ [data-orientation="vertical"]`);
    await expect(bar).toBeVisible();
    const track = await bar.boundingBox();
    await page.mouse.move(track!.x + track!.width / 2, track!.y + 6);
    await page.mouse.down();
    await page.mouse.move(track!.x + track!.width / 2, track!.y + track!.height - 6, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator(MENU)).toBeVisible();
    await expect(page.locator(EDITOR)).toBeFocused();
  });

  test('closes when a co-editor deletes the line it is on, and typing carries on', async ({ browser }) => {
    await openFreshDocument(page);
    await page.keyboard.type('keep');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/he');
    await expect(page.locator(MENU)).toBeVisible();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
    try {
      await other.goto(page.url());
      const line = other.locator(EDITOR).getByText('/he');
      await expect(line).toBeVisible({ timeout: 15_000 });
      await line.click();
      await other.keyboard.press('End');
      for (let i = 0; i < 4; i += 1) await other.keyboard.press('Backspace');
      await expect.poll(() => lines(other)).toEqual(['paragraph:keep']);
    } finally {
      await other.close();
    }
    await expect(page.locator(MENU)).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => lines(page)).toEqual(['paragraph:keep']);
    await page.keyboard.type('!');
    await expect.poll(() => lines(page)).toEqual(['paragraph:keep!']);
    expect(errors).toEqual([]);
  });

  test('lights the first cell on Enter in a grid the pointer opened, and inserts it on the next Enter', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('/table');
    const table = await page.getByTestId('doc-slash-row-table').boundingBox();
    await page.mouse.move(table!.x + 20, table!.y + table!.height / 2, { steps: 3 });
    await expect(page.getByTestId('doc-slash-table-grid')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('doc-slash-table-size-1-1')).toHaveAttribute('data-on', '');
    await page.keyboard.press('Enter');
    await expect(page.locator(MENU)).toBeHidden();
    await expect.poll(() => lines(page)).toContain('docTable');
  });
});
