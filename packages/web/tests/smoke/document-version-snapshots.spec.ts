// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Document snapshots end to end (inner#1129): save one from the menu, rename
 * it, preview and compare it in the panel, restore it into the body, see a
 * second page of the document receive the restore through collab and keep it
 * across a real reload, take it back with a real Cmd/Ctrl+Z, and delete the
 * snapshot. What each control shows for a viewer is pinned in
 * `document-version-panel.test.tsx`; the role reaching the body is walked by
 * `document-viewer-no-strip.spec.ts`.
 */

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, VISIBLE_SPACE } from '../helpers/space';

const created: string[] = [];

test.afterEach(async ({ page }) => {
  while (created.length > 0) await deleteSpace(page, created.pop() as string);
});

/**
 * Opens the snapshot panel from the document menu.
 * @param page - The page.
 */
async function openPanel(page: Page): Promise<void> {
  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-restore-snapshot').click();
  await expect(page.getByTestId('doc-version-panel')).toBeVisible({ timeout: 15_000 });
}

/**
 * The body's words, without the caret labels collaborators draw inside it.
 * @param page - The page.
 * @returns The first paragraph's text.
 */
function firstLine(page: Page) {
  return page.locator(`${EDITOR} p`).first();
}

test('saves, renames, previews, compares, restores, undoes and deletes a snapshot', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 950 });
  await openSmokeProject(page);
  created.push(await createSpace(page, 'document', `snapshots-${Date.now()}`));
  const home = (await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-testid'))!;
  await page.locator(EDITOR).click();
  await page.keyboard.type('version one');

  // Save, named.
  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-save-snapshot').click();
  await page.getByTestId('doc-snapshot-name-input').fill('First');
  await page.getByTestId('doc-snapshot-name-submit').click();
  await expect(page.getByTestId('doc-snapshot-name-dialog')).toHaveCount(0, { timeout: 15_000 });

  await firstLine(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await expect(firstLine(page)).toHaveText('version one and more');

  // Rename from the row's menu.
  await openPanel(page);
  const row = page.locator('[data-testid^="doc-version-row-"]:not([data-testid="doc-version-row-current"])').first();
  await expect(row).toContainText('First', { timeout: 15_000 });
  await row.hover();
  await page.locator('[data-testid^="doc-version-row-menu-"]').first().click();
  await page.getByTestId('doc-version-rename').click();
  await page.getByTestId('doc-snapshot-name-input').fill('Renamed');
  await page.getByTestId('doc-snapshot-name-submit').click();
  await expect(row).toContainText('Renamed', { timeout: 15_000 });

  // Preview, then compare with the current content.
  await row.click();
  const preview = page.getByTestId('doc-version-preview-body');
  await expect(preview).toHaveText('version one', { timeout: 15_000 });
  await expect(page.locator(`${VISIBLE_SPACE} [data-testid="document-body-column"]`)).toHaveClass(/invisible/);
  await page.getByTestId('doc-version-compare-current').click();
  await expect(preview.locator('.doc-version-insert')).toContainText('and more', { timeout: 15_000 });
  // Leaving a comparison shows the later of the two, the current content here.
  await page.getByTestId('doc-version-exit-compare').click();
  await expect(preview).toHaveText('version one and more');
  await expect(page.getByTestId('doc-version-banner')).toHaveCount(0);
  await row.click();
  await expect(preview).toHaveText('version one', { timeout: 15_000 });

  // Restore, as one step everyone sees.
  await page.getByTestId('doc-version-restore').click();
  await page.getByTestId('doc-version-restore-confirm').click();
  await expect(page.getByTestId('doc-version-panel')).toHaveCount(0, { timeout: 15_000 });
  await expect(firstLine(page)).toHaveText('version one');

  const peer = await page.context().newPage();
  try {
    await peer.setViewportSize({ width: 1680, height: 950 });
    await peer.goto(page.url());
    await peer.getByTestId(home).click();
    await expect(firstLine(peer)).toContainText('version one', { timeout: 20_000 });
    await expect(firstLine(peer)).not.toContainText('and more');
    // What the server keeps, read again from scratch.
    await peer.reload();
    await peer.getByTestId(home).click();
    await expect(firstLine(peer)).toContainText('version one', { timeout: 20_000 });
    await expect(firstLine(peer)).not.toContainText('and more');

    // One real undo takes the whole restore back, for everyone.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(firstLine(page)).toHaveText('version one and more');
    await expect(firstLine(peer)).toContainText('version one and more', { timeout: 20_000 });
    await peer.reload();
    await peer.getByTestId(home).click();
    await expect(firstLine(peer)).toContainText('version one and more', { timeout: 20_000 });
  } finally {
    await peer.close();
  }

  // Delete it.
  await openPanel(page);
  await expect(row).toContainText('Renamed', { timeout: 15_000 });
  await row.hover();
  await page.locator('[data-testid^="doc-version-row-menu-"]').first().click();
  await page.getByTestId('doc-version-delete').click();
  await page.getByTestId('doc-version-delete-confirm').click();
  await expect(page.getByTestId('doc-version-empty')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('doc-version-close').click();
  await expect(firstLine(page)).toHaveText('version one and more');
});
