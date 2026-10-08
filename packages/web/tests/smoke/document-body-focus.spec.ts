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
    return { x: editor.left - 40, y: editor.top + 12 };
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
  await p.locator(EDITOR).click();
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
    const box = document.querySelector(selector)!.getBoundingClientRect();
    return { x: box.left + 200, y: box.top + 12 };
  }, EDITOR);

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(EDITOR)).toHaveAttribute('data-body-holds', /.*/);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).not.toBe('');
});
