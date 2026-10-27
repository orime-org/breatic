// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

const catalogs = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'].map((code) => ({ code,
  threeD: (JSON.parse(readFileSync(resolve(__dirname, '../../../../locales', `${code}.json`), 'utf8')) as { spaces: { threeD: Record<string, string> } }).spaces.threeD,
}));

/**
 * Change the locale through the actual header menu.
 * @param page - The slot's signed-in page.
 * @param code - The supported locale to select.
 * @throws {Error} When the header menu cannot be used.
 */
async function locale(page: Page, code: string): Promise<void> {
  await page.getByTestId('lang-trigger').click();
  await page.getByTestId(`lang-option-${code}`).click();
}

test.use({ viewport: { width: 1440, height: 900 } });

test('scene panel dismissal preserves header menu focus and every locale uses the project file button', async ({ page }) => {
  await openSmokeProject(page); await locale(page, 'en');
  const id = await createSpace(page, '3d', `scene-focus-${Date.now()}`);
  try {
    const scene = visibleSpace(page);
    await scene.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Add figure', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('scene-right-panel')).toBeVisible();
    await page.getByTestId('lang-trigger').click();
    await expect(page.getByTestId('scene-right-panel')).toHaveCount(0);
    await expect(page.getByTestId('lang-popover')).toBeVisible();
    await expect(page.getByTestId('lang-option-en')).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByTestId('lang-option-zh-CN')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(scene.getByRole('button', { name: catalogs[1].threeD.generate, exact: true })).toBeVisible();
    await scene.getByTestId('scene-properties-trigger').click();
    await expect(page.getByTestId('scene-right-panel')).toBeVisible();
    await page.getByTestId('theme-toggle').click();
    await expect(page.getByTestId('scene-right-panel')).toHaveCount(0);
    await expect(page.getByTestId('theme-option-dark')).toBeVisible();
    await page.getByTestId('theme-option-dark').click();
    for (const catalog of catalogs) {
      await locale(page, catalog.code);
      await scene.getByRole('button', { name: catalog.threeD.generate, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: catalog.threeD.generate, exact: true });
      await expect(dialog.getByRole('button', { name: catalog.threeD.chooseReference, exact: true })).toBeDisabled();
      await expect(dialog.getByLabel(catalog.threeD.reference, { exact: true })).toBeHidden();
      await expect(dialog.getByRole('button', { name: catalog.threeD.submit, exact: true })).toBeDisabled();
      await page.screenshot({ path: test.info().outputPath(`scene-reference-${catalog.code}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    }
  } finally { await page.keyboard.press('Escape'); await deleteSpace(page, id); await locale(page, 'en'); }
});
