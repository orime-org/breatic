// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { uploadableFormatList, uploadableSpellings } from '@breatic/shared';
import { test } from '../helpers/slot';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace, VISIBLE_SPACE } from '../helpers/space';
import { startNewConversation } from '../helpers/conversation';
import { roomForUploads } from '../helpers/upload-budget';

const SVG = readFileSync(join(__dirname, '../fixtures/unsupported-format.svg'));
let spaceId = '';
let pageErrors: string[] = [];

/**
 * Assert the visible format refusal names the file and supported images.
 * @param page - The current project page.
 * @param filename - The rejected file.
 * @returns The completed assertion.
 * @throws {Error} When the warning is absent or incomplete.
 */
async function expectImageRefusal(page: Page, filename: string): Promise<void> {
  const warning = page.locator('[data-sonner-toast]').filter({ hasText: filename });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('isn’t a supported format');
  await expect(warning).toContainText(uploadableFormatList('image'));
}

/**
 * Deliver the fixed unsupported image through a real clipboard or drop event.
 * @param page - The current project page.
 * @param entry - The event path being checked.
 * @param composer - Whether the file is aimed at the Agent composer.
 * @returns The delivered event.
 * @throws {Error} When the target is not mounted.
 */
async function offerSvg(page: Page, entry: 'drop' | 'paste', composer = false): Promise<void> {
  const selector = composer ? '[data-testid="chat-composer-box"]' : `${VISIBLE_SPACE} .react-flow__pane`;
  if (composer) await page.getByTestId('chat-composer-box').focus();
  else await visibleSpace(page).locator('.react-flow__pane').click();
  await page.evaluate(({ at, how, source }) => {
    const target = document.querySelector(at);
    if (target === null) throw new Error('The file entry is not mounted');
    const data = new DataTransfer();
    data.items.add(new File([source], 'vector.svg', { type: 'image/svg+xml' }));
    if (how === 'paste') {
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    } else {
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  }, { at: selector, how: entry, source: SVG.toString('utf8') });
}

test.beforeEach(async ({ page }) => {
  spaceId = '';
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `upload formats ${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow__pane')).toBeVisible();
  await startNewConversation(page);
});

test.afterEach(async ({ page }) => {
  try {
    if (spaceId) await deleteSpace(page, spaceId);
  } finally {
    expect(pageErrors).toEqual([]);
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`the main picker offers supported media before rejecting an SVG in ${theme}`, async ({ page }) => {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const choosing = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload assets (mixed files)', exact: true }).focus();
    await page.keyboard.press('Enter');
    const chooser = await choosing;
    const accept = (await chooser.element().getAttribute('accept'))?.split(',') ?? [];
    expect([...accept].sort()).toEqual([...uploadableSpellings(), 'text/*'].sort());
    await chooser.setFiles({ name: 'vector.svg', mimeType: 'image/svg+xml', buffer: SVG });
    await expectImageRefusal(page, 'vector.svg');
    await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(0);
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'vector.svg' })).toHaveAttribute('data-mounted', 'true');
    await page.screenshot({ path: test.info().outputPath(`main-refusal-${theme}.png`), fullPage: true, animations: 'disabled' });
  });
}

for (const entry of ['drop', 'paste'] as const) {
  test(`the canvas explains an unsupported image received by ${entry}`, async ({ page }) => {
    await offerSvg(page, entry);
    await expectImageRefusal(page, 'vector.svg');
    await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(0);
  });
}

for (const entry of ['pick', 'paste'] as const) {
  test(`the Agent explains an unsupported image received by ${entry}`, async ({ page }) => {
    if (entry === 'pick') {
      await page.getByTestId('chat-composer-file-input').setInputFiles({ name: 'vector.svg', mimeType: 'image/svg+xml', buffer: SVG });
    } else {
      await offerSvg(page, 'paste', true);
    }
    await expectImageRefusal(page, 'vector.svg');
    await expect(page.getByTestId('chat-composer-chips')).toHaveCount(0);
  });
}

test('the Agent explains a real upload format refusal and can recover after removal @needs-ingest @needs-storage', async ({ page }) => {
  await roomForUploads(1);
  const filename = `mislabeled-${Date.now()}.png`;
  await page.getByTestId('chat-composer-file-input').setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer: Buffer.from(SVG.toString('utf8').replace('</svg>', `<!-- ${filename} --></svg>`)),
  });
  const chips = page.getByTestId('chat-composer-chips');
  await expect(chips.locator('[data-status="failed"]')).toContainText(filename, { timeout: 60_000 });
  await expectImageRefusal(page, filename);
  await expect(page.getByTestId('chat-composer-send')).toBeDisabled();
  await chips.getByRole('button', { name: `Remove ${filename}`, exact: true }).click();
  await page.getByTestId('chat-composer-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Readable notes') });
  await expect(chips.locator('[data-status="ready"]')).toContainText('notes.txt');
  await page.getByTestId('chat-composer-box').fill('Use the notes');
  await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
});
