// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Handing a document's words to the Agent, end to end: from the bubble bar
 * over a selection and from the block handle's menu over one line, into the
 * tray above the chat box and out with the next message.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { openFreshDocument, selectParagraph } from '../helpers/bubble-bar';

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const AGENT_COLUMN = '[data-testid="agent-column"]';
const SELECTION_CHIP = '[data-testid^="chat-chip-document-selection-"]';
const BLOCK_CHIP = '[data-testid^="chat-chip-document-block-"]';

/**
 * Hovers one line and opens its handle's menu.
 * @param p - The page.
 * @param index - Which line, from the top.
 * @throws {Error} When that line has no box.
 */
async function openHandleMenu(p: Page, index: number): Promise<void> {
  // The handle stays away while text is selected, and the bar over a
  // selection can sit on the line wanted: collapse it from the keyboard.
  if (await p.getByTestId('doc-selection-bubble-bar').isVisible()) {
    await p.keyboard.press('ArrowRight');
    await expect(p.getByTestId('doc-selection-bubble-bar')).not.toBeAttached({ timeout: 5_000 });
  }
  await p.mouse.move(5, 5);
  const row = p.locator(`${EDITOR} .bn-block-content`).nth(index);
  const box = await row.boundingBox();
  if (box === null) throw new Error(`row ${index} has no box`);
  await p.mouse.move(box.x + 40, box.y + 11);
  await p.getByTestId('doc-block-handle').click();
}

test('the selection and a line go into the tray and out with the next message', async ({ page }) => {
  // Held, never answered: what is read is what the box sent.
  await page.route('**/chat/message', () => undefined);
  await openFreshDocument(page);
  await page.keyboard.type('alpha bravo');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await expect(page.locator(`${EDITOR} p`)).toHaveText(['alpha bravo', 'Second line']);

  // A hidden Agent panel opens for the item (A3).
  await page.getByTestId('agent-toggle').click();
  await expect(page.locator(AGENT_COLUMN)).toHaveCount(0);

  await selectParagraph(page, 0);
  await page.getByTestId('doc-bubble-tool-addToAgent').click();
  await expect(page.locator(AGENT_COLUMN)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(SELECTION_CHIP)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(SELECTION_CHIP)).toContainText('alpha bravo');
  // Into the tray, not the box (A4).
  await expect(page.getByTestId('chat-composer-box')).toHaveText('');

  // The same words again, then a line from its handle's menu (A2). Both
  // calls read the tray's limits from the one cached request, so the second
  // add of the selection has landed by the time the line's chip shows, and
  // the same words have left one item (A5).
  await page.getByTestId('doc-bubble-tool-addToAgent').click();
  await openHandleMenu(page, 1);
  await page.getByTestId('doc-block-row-addToAgent').click();
  await expect(page.locator(BLOCK_CHIP)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator(BLOCK_CHIP)).toContainText('Second line');
  await expect(page.locator(SELECTION_CHIP)).toHaveCount(1);

  // The same line, edited and handed over again, is one item holding the
  // new words (A5).
  await page.locator(`${EDITOR} p`).nth(1).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await openHandleMenu(page, 1);
  await page.getByTestId('doc-block-row-addToAgent').click();
  await expect(page.locator(BLOCK_CHIP)).toHaveCount(1);
  await expect(page.locator(BLOCK_CHIP)).toContainText('Second line edited');

  const sent = page.waitForRequest((req) => req.url().includes('/chat/message') && req.method() === 'POST');
  const box = page.getByTestId('chat-composer-box');
  await box.click();
  await box.pressSequentially('what do these say');
  await box.press('Enter');
  const body = (await sent).postDataJSON() as {
    attached_chips: { id: string; type: string; data_snapshot: { text?: string } }[];
  };
  const texts = body.attached_chips.map((chip) => [chip.type, chip.data_snapshot.text]);
  expect(texts).toEqual([
    ['text', 'alpha bravo'],
    ['text', 'Second line edited'],
  ]);
});
