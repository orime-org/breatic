// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Locator, type Page } from 'playwright/test';
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

/**
 * Count actual blue-to-neutral contour neighbours in the completed WebGL frame.
 * @param canvas - The native canvas whose frame is read before compositing clears it.
 * @param neutral - The expected inner contour's byte value from the active theme.
 * @param outer - The expected outer contour's byte value from the active theme.
 * @returns Native core and contour edge sample counts.
 * @throws {Error} When the pixel copy cannot be constructed.
 */
async function contourPixels(canvas: Locator, neutral: number, outer: number): Promise<{ blue: number; adjacentContour: number; outerContour: number }> {
  return canvas.evaluate((element, inks) => new Promise<{ blue: number; adjacentContour: number; outerContour: number }>((resolveResult) => {
    requestAnimationFrame(() => {
      const source = element as HTMLCanvasElement;
      const copy = document.createElement('canvas'); copy.width = source.width; copy.height = source.height;
      const context = copy.getContext('2d'); if (!context) throw new Error('Expected a frame copy context');
      context.drawImage(source, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, copy.width, copy.height);
      let blue = 0; let adjacentContour = 0; let outerContour = 0;
      for (let y = 8; y < height - 8; y++) for (let x = 8; x < width - 8; x++) {
        const index = (y * width + x) * 4;
        if (data[index] !== 0 || data[index + 1] !== 0 || data[index + 2] !== 255 || data[index + 3] !== 255) continue;
        blue++;
        let found = false; let foundOuter = false;
        for (let dy = -8; dy <= 8 && !(found && foundOuter); dy++) for (let dx = -8; dx <= 8; dx++) {
          const nearby = ((y + dy) * width + x + dx) * 4;
          if (data[nearby] === inks.inner && data[nearby + 1] === inks.inner && data[nearby + 2] === inks.inner && data[nearby + 3] === 255 && Math.abs(dx) <= 4 && Math.abs(dy) <= 4) found = true;
          if (data[nearby] === inks.outer && data[nearby + 1] === inks.outer && data[nearby + 2] === inks.outer && data[nearby + 3] === 255) foundOuter = true;
          if (found && foundOuter) break;
        }
        if (found) adjacentContour++;
        if (found && foundOuter) outerContour++;
      }
      resolveResult({ blue, adjacentContour, outerContour });
    });
  }), { inner: neutral, outer });
}

for (const dpr of [1, 2]) test.describe(`native contours at DPR ${dpr}`, () => {
  test.use({ deviceScaleFactor: dpr });
  test('native move, rotate and scale keep visible contours in both themes', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await openSmokeProject(page); await locale(page, 'en');
    const id = await createSpace(page, '3d', `scene-contours-${Date.now()}`);
    try {
      const scene = visibleSpace(page); const canvas = scene.getByTestId('three-d-viewport');
      await scene.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Add figure', exact: true })).toHaveCount(0);
      await expect(page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true })).toHaveValue('Figure');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByTestId('scene-right-panel')).toHaveCount(0);
      for (const theme of ['light', 'dark']) {
        await page.getByTestId('theme-toggle').click(); await page.getByTestId(`theme-option-${theme}`).click();
        for (const name of ['Move', 'Rotate', 'Scale']) {
          await scene.getByRole('button', { name, exact: true }).click(); await page.mouse.move(700, 20);
          await expect.poll(async () => {
            const sample = await contourPixels(canvas, theme === 'dark' ? 240 : 227, theme === 'dark' ? 44 : 30);
            return sample.adjacentContour;
          }).toBeGreaterThanOrEqual(12);
          const sample = await contourPixels(canvas, theme === 'dark' ? 240 : 227, theme === 'dark' ? 44 : 30);
          expect(sample.blue).toBeGreaterThanOrEqual(24);
          expect(sample.outerContour).toBeGreaterThanOrEqual(12);
          await test.info().attach(`${theme}-${name}-DPR-${dpr}-pixels`, { body: JSON.stringify(sample), contentType: 'application/json' });
          await page.screenshot({ path: test.info().outputPath(`${theme}-${name}-DPR-${dpr}.png`), animations: 'disabled' });
        }
      }
      expect(errors).toEqual([]);
    } finally { await deleteSpace(page, id); }
  });
});
