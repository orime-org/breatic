// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Locator, type Page } from 'playwright/test';

import { DOCUMENT_EDITOR } from './space';

/**
 * Resizes a document column through its visible border grip.
 * @param page - The page holding the table.
 * @param cell - A visible cell of the column.
 * @param width - The requested rendered column width.
 * @throws {Error} When the cell has no rendered box.
 */
export async function resizeDocumentColumn(page: Page, cell: Locator, width: number): Promise<void> {
  const box = await cell.boundingBox();
  if (box === null) throw new Error('The document cell has no rendered box');
  const edge = box.x + box.width - 1;
  const y = box.y + box.height - 4;
  await page.mouse.move(edge - 15, y);
  await page.mouse.move(edge, y, { steps: 3 });
  await expect(page.locator(`${DOCUMENT_EDITOR} .column-resize-handle`)).not.toHaveCount(0);
  await page.mouse.down();
  await page.mouse.move(edge + width - box.width, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(((await cell.boundingBox())?.width ?? Infinity) - width)).toBeLessThanOrEqual(1);
}
