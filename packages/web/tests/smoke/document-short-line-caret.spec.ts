// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pressing in the room to the right of a line whose text is short.
 *
 * A reader drags across a short line to select it, and on a bulleted item that
 * used to select nothing — the moment the pointer passed the end of the text,
 * the selection collapsed back to the start of the line. The same fault shows
 * up in one click: pressing out to the right of a bulleted item put the caret
 * at the START of that line, where every other kind of block puts it at the
 * end. These cases are about that click, because it is the same resolution
 * with nothing else in it.
 *
 * A block's content is a flex row holding a marker and the inline content, and
 * neither of them grows, so the width between the last glyph and the block's
 * right edge belongs to no box. Asked for a caret position out there, the
 * browser takes the nearest box that has height — and what it finds decides
 * the answer. Measured across the four kinds on one document:
 *
 *   paragraph  marker is a 0x0 `::before`                  -> end of the text
 *   numbered   marker is a `::before`, 21.8px wide, 0 high -> end of the text
 *   to-do      marker is a real 24x24 `div` holding a box  -> end of the text
 *   bulleted   marker is a `::before`, 24 wide, 22.5 high  -> START of the line
 *
 * The bullet is the one this Space draws itself, with a gradient, and a
 * gradient needs a box with height to paint in. A pseudo-element carries no
 * DOM node, so it holds no caret position at all: once its box is the nearest
 * one, the browser falls back to the position before the inline content, which
 * is the head of the line.
 *
 * So the inline content is made to fill its row. That leaves no width outside
 * a box for the fallback to happen in, which is what a block-level paragraph
 * gives every editor that does not lay its blocks out with flex.
 *
 * All four kinds are covered: three of them work today by way of a marker that
 * happens to have no height, and this is what says so.
 *
 * Needs dev running plus a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');
// Serial: the lines are built once, and each case only reads one of them.
test.describe.configure({ mode: 'serial' });

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const BLOCK = `${EDITOR} .bn-block-content`;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The lines, each short enough that 1680px leaves room to its right.
 *
 * Kinds that convert to the same block are kept apart so that converting one
 * line cannot merge it with the line built before it, and the quoted bullet
 * sits beside the to-do rather than beside the plain bullet for the same
 * reason.
 */
const LINES = [
  { name: 'a plain paragraph', text: 'plain line', rows: [] },
  { name: 'a bulleted item', text: 'bulleted line', rows: ['bullet-list'] },
  { name: 'a to-do item', text: 'task line', rows: ['task-list'] },
  {
    name: 'a bulleted item inside a quote',
    text: 'quoted bullet',
    rows: ['bullet-list', 'quote'],
  },
  { name: 'a numbered item', text: 'numbered line', rows: ['ordered-list'] },
] as const;

let page: Page;
let spaceId = '';

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

  await page.goto('/studio');
  const first = page.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  await first.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });
  spaceId = await createSpace(page, 'document', `short-${Date.now()}`);

  const editor = page.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // The new-Space dialog hands focus back to its trigger asynchronously;
  // typing before that lands goes to the button.
  await expect(page.getByTestId('new-space-button')).toBeFocused();
  await editor.click();

  // Every line is typed as a plain paragraph first. Enter at the end of a list
  // item continues that list and inside a quote stays in the quote, so
  // building each kind in turn would nest the ones that follow.
  for (const [index, line] of LINES.entries()) {
    if (index > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line.text);
  }
  for (const line of LINES) {
    if (line.rows.length === 0) continue;
    // On the text itself: a block's content element runs the full width, and
    // its centre is out in the room these cases are about.
    await lineOf(line.text).click({ position: { x: 6, y: 10 } });
    for (const row of line.rows) await applyRow(row);
  }
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  if (spaceId) await deleteSpace(page, spaceId);
  await page?.close();
});

/**
 * The block holding one of the lines.
 * @param text - That line's text.
 * @returns A locator for its content element.
 */
function lineOf(text: string) {
  return page.locator(BLOCK).filter({ hasText: text }).last();
}

/**
 * Applies one block type menu row to the line the caret is on.
 * @param row - The row's id.
 * @throws {Error} When the bubble bar or the row never appears.
 */
async function applyRow(row: string): Promise<void> {
  // `Mod+A`'s first tier takes the block the caret is in, which is how the
  // block type spec selects a line for this menu.
  await page.keyboard.press(`${MOD}+a`);
  const slot = page.getByTestId('doc-bubble-block-type');
  await expect(slot).toBeVisible({ timeout: 10_000 });
  await slot.hover();
  const item = page.getByTestId(`doc-bubble-block-type-item-${row}`);
  await expect(item).toBeVisible({ timeout: 10_000 });
  await item.click();
  await expect(slot).toBeVisible({ timeout: 10_000 });
}

/**
 * Clicks halfway between the end of a line's text and the block's right edge.
 * @param text - The line's text.
 * @returns Where the caret ended up, as text and offset.
 * @throws {Error} When that line holds no text.
 */
async function caretAfterClickingPastTheText(text: string): Promise<string> {
  const box = await lineOf(text).evaluate((block: HTMLElement) => {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) throw new Error('no text in that line');
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    const own = block.getBoundingClientRect();
    return {
      x: (rect.right + own.right) / 2,
      y: (rect.top + rect.bottom) / 2,
    };
  });

  await page.mouse.click(box.x, box.y);
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.anchorNode === null) return 'no selection';
    const node = selection.anchorNode;
    const held = node.nodeType === Node.TEXT_NODE ? node.textContent : '';
    return `${held ?? ''}@${selection.anchorOffset}`;
  });
}

for (const line of LINES) {
  test(`puts the caret at the end of ${line.name}`, async () => {
    expect(await caretAfterClickingPastTheText(line.text)).toBe(
      `${line.text}@${line.text.length}`,
    );
  });
}
