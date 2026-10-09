// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The body's focus end to end (inner#1127 A20, A21).
 *
 * What jsdom cannot show: a real press on the blank space beside the body
 * column, where the browser's focus then is, the native selection highlight
 * going with it, and the keys the page sends while the body is let go.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, VISIBLE_SPACE } from '../helpers/space';

const SCROLLER = `${VISIBLE_SPACE} [data-testid="document-space"] [data-radix-scroll-area-viewport][data-document-body-blank]`;
const BUBBLE_BAR = '[data-testid="doc-selection-bubble-bar"]';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let page: Page;
const createdSpaceIds: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

/**
 * Opens a fresh Document Space holding one line of text, the body holding.
 * @param p - The page.
 */
async function openWithLine(p: Page): Promise<void> {
  await openSmokeProject(p);
  createdSpaceIds.push(await createSpace(p, 'document', `body-focus-${Date.now()}`));
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await p.keyboard.type('hello world');
  await expect(editor).toHaveAttribute('data-body-holds', /.*/);
}

/**
 * A point on the blank space left of the body column, checked to be blank.
 * @param p - The page.
 * @returns The point.
 */
async function blankPoint(p: Page): Promise<{ x: number; y: number }> {
  const point = await p.evaluate((selector) => {
    const editor = document.querySelector(selector)!.getBoundingClientRect();
    const line = document.querySelector(`${selector} p`)!.getBoundingClientRect();
    return { x: editor.left - 40, y: line.top + line.height / 2 };
  }, EDITOR);
  const blank = await p.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-document-body-blank') ?? false,
    point,
  );
  expect(blank).toBe(true);
  return point;
}

/**
 * Selects the word "hello" on the first line.
 * @param p - The page.
 */
async function selectHello(p: Page): Promise<void> {
  await p.locator(`${EDITOR} p`).first().click({ position: { x: 2, y: 8 } });
  await p.keyboard.press('Home');
  for (let i = 0; i < 5; i += 1) await p.keyboard.press('Shift+ArrowRight');
  await expect(p.locator(BUBBLE_BAR)).toBeVisible();
}

test('a press on blank space lets the body go and leaves the focus on the body scroller', async () => {
  await openWithLine(page);
  await selectHello(page);
  const { x, y } = await blankPoint(page);

  await page.mouse.click(x, y);

  const editor = page.locator(EDITOR);
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
  await expect(page.locator(BUBBLE_BAR)).toHaveCount(0);
  await expect(page.locator(SCROLLER)).toBeFocused();
  expect(await page.locator(SCROLLER).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
  // The selection is kept, only not drawn: a press back in the text takes it.
  await editor.click();
  await expect(editor).toHaveAttribute('data-body-holds', /.*/);
});

test('cut and paste do nothing while the body is let go, and undo still reaches the document', async () => {
  await openWithLine(page);
  await selectHello(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  const editor = page.locator(EDITOR);

  await page.keyboard.press(`${MOD}+x`);
  await page.keyboard.press(`${MOD}+v`);
  await expect(editor).toHaveText('hello world');

  await page.keyboard.press(`${MOD}+z`);
  await expect(editor).not.toHaveText('hello world');
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
});

test('a drag that starts on blank space selects from the press point and takes the body back', async () => {
  await openWithLine(page);
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  const end = await page.evaluate((selector) => {
    const line = document.querySelector(`${selector} p`)!.getBoundingClientRect();
    return { x: line.left + 40, y: line.top + line.height / 2 };
  }, EDITOR);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(EDITOR)).toHaveAttribute('data-body-holds', /.*/);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
});

test('Tab back into the body after the caption field keeps the scroll position and the selected picture', async () => {
  await openWithLine(page);
  for (let i = 0; i < 30; i += 1) await page.keyboard.type(`\nline ${String(i)}`);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 120;
    canvas.getContext('2d')!.fillRect(0, 0, 220, 120);
    const blob = await new Promise<Blob>((done) => {
      canvas.toBlob((b) => done(b!), 'image/png');
    });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator(EDITOR).evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], 'tab.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);
  const picture = page.locator(`${EDITOR} [data-content-type="image"]`);
  await expect(picture.locator('img')).toBeVisible({ timeout: 60_000 });
  const knob = picture.locator('[data-testid="doc-media-resize-se"]');
  await picture.locator('img').click();
  await expect(knob).toBeVisible();
  await picture.getByTestId('doc-media-caption-button').click();
  await page.keyboard.type('Dusk');
  const beside = await picture.evaluate((row, selector) => {
    const editor = document.querySelector(selector)!.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return { x: editor.left - 40, y: box.top + box.height / 2 };
  }, EDITOR);
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute('data-document-body-blank'), beside),
  ).toBe(true);
  await page.mouse.click(beside.x, beside.y);
  await expect(page.locator(SCROLLER)).toBeFocused();
  const before = await page.locator(SCROLLER).evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);

  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    if (await page.locator(EDITOR).evaluate((el) => el === document.activeElement)) break;
  }

  await expect(page.locator(EDITOR)).toBeFocused();
  expect(await page.locator(SCROLLER).evaluate((el) => el.scrollTop)).toBe(before);
  await expect(knob).toBeVisible();
});

test('a body let go draws neither its text selection nor its selected cells (A20, A21)', async () => {
  await openWithLine(page);
  await selectHello(page);
  const editor = page.locator(EDITOR);
  const textHighlight = (): Promise<string> =>
    page.locator(`${EDITOR} p`).first().evaluate((el) => getComputedStyle(el, '::selection').backgroundColor);
  expect(await textHighlight()).not.toBe('rgba(0, 0, 0, 0)');

  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
  expect(await textHighlight()).toBe('rgba(0, 0, 0, 0)');

  // A 2x2 table below the line, its four cells selected by a drag.
  await editor.click();
  await page.mouse.move(5, 5);
  const row = (await page.locator(`${EDITOR} .bn-block-content`).first().boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + 12, { steps: 3 });
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  const first = (await page.locator(`${EDITOR} td`).first().boundingBox())!;
  const last = (await page.locator(`${EDITOR} td`).last().boundingBox())!;
  await page.mouse.move(first.x + 10, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 10, last.y + last.height / 2, { steps: 6 });
  await page.mouse.up();
  const cell = page.locator(`${EDITOR} .selectedCell`).first();
  await expect(cell).toBeVisible();
  const tint = (): Promise<string> => cell.evaluate((el) => getComputedStyle(el, '::after').content);
  expect(await tint()).not.toBe('none');

  await page.mouse.click(x, y);
  await expect(editor).not.toHaveAttribute('data-body-holds', /.*/);
  expect(await tint()).toBe('none');
});
