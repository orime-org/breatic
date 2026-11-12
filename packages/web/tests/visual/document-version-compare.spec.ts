// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a snapshot comparison looks like in the real app (inner#1129 design
 * §7.2, §7.3): both compared rows carry the one selected look, added words
 * are green, removed words red and struck through, the banner's legend uses
 * the same colours, and a long unchanged stretch folds into one row. Checked
 * in both themes against the palette tokens themselves.
 */

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

let page: Page;
const created: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

test.afterEach(async () => {
  while (created.length > 0) await deleteSpace(page, created.pop() as string);
  await page.close();
});

/**
 * A token's colour in the theme now on screen.
 * @param p - The page.
 * @param name - The token, without `--`.
 * @param property - Which property to resolve it through.
 * @returns Its computed value.
 */
async function token(p: Page, name: string, property: 'color' | 'backgroundColor' | 'borderTopColor'): Promise<string> {
  return p.evaluate(([variable, prop]) => {
    const probe = document.createElement('span');
    probe.style.border = '1px solid transparent';
    probe.style[prop as 'color'] = `var(--${variable})`;
    document.body.appendChild(probe);
    const seen = getComputedStyle(probe)[prop as 'color'];
    probe.remove();
    return seen;
  }, [name, property] as const);
}

/**
 * Puts the page into one theme, as the theme store does.
 * @param p - The page.
 * @param theme - Which one.
 */
async function setTheme(p: Page, theme: 'light' | 'dark'): Promise<void> {
  const before = await token(p, 'color-background', 'color');
  await p.evaluate((next) => {
    document.documentElement.dataset.theme = next;
  }, theme);
  if (theme === 'dark') await expect.poll(() => token(p, 'color-background', 'color')).not.toBe(before);
}

test('marks a comparison in the palette colours, selects both rows and folds what did not change, in both themes', async () => {
  await openSmokeProject(page);
  created.push(await createSpace(page, 'document', `compare-${Date.now()}`));
  await page.locator(EDITOR).click();
  const lines = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
  await page.keyboard.type(lines.join('\n'));
  await expect(page.locator(`${EDITOR} p`)).toHaveCount(lines.length);

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-save-snapshot').click();
  await page.getByTestId('doc-snapshot-name-submit').click();
  await expect(page.getByTestId('doc-snapshot-name-dialog')).toHaveCount(0, { timeout: 15_000 });

  // Change the last line: everything above it is one unchanged stretch.
  const last = page.locator(`${EDITOR} p`).last();
  await last.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('O');
  await expect(last).toHaveText('indiO');

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-restore-snapshot').click();
  const row = page.locator('[data-testid^="doc-version-row-"]:not([data-testid="doc-version-row-current"])').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await page.getByTestId('doc-version-compare-current').click();
  const preview = page.getByTestId('doc-version-preview-body');
  await expect(preview.locator('.doc-version-insert')).toHaveText('O', { timeout: 15_000 });

  // Seven unchanged lines above the change keep one beside it and fold the rest.
  await expect(page.getByTestId('doc-version-fold')).toHaveCount(1);
  await expect(preview.locator('.doc-version-folded')).toHaveCount(7);
  await expect(page.getByTestId('doc-version-row-current')).toHaveAttribute('data-active', 'true');
  await expect(row).toHaveAttribute('data-active', 'true');

  // Switching to another Space and back keeps the comparison as it was.
  const home = (await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-testid'))!;
  created.push(await createSpace(page, 'document', `compare-other-${Date.now()}`));
  await page.getByTestId(home).click();
  await expect(page.getByTestId('doc-version-fold')).toHaveCount(1, { timeout: 15_000 });
  await expect(preview.locator('.doc-version-folded')).toHaveCount(7);
  await expect(preview.locator('.doc-version-insert')).toHaveText('O');
  await expect(row).toHaveAttribute('data-active', 'true');

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    const greenBg = await token(page, 'color-palette-green-bg', 'backgroundColor');
    const red = await token(page, 'color-palette-red', 'color');
    const active = await token(page, 'color-active-border', 'borderTopColor');

    for (const added of [preview.locator('.doc-version-insert'), page.locator('.doc-version-legend-insert')]) {
      // Added text reads in the colour of the text around it; the green is its background.
      const around = await added.evaluate((el) => getComputedStyle(el.parentElement!).color);
      await expect(added).toHaveCSS('color', around);
      await expect(added).toHaveCSS('background-color', greenBg);
    }
    for (const removed of [preview.locator('.doc-version-delete'), page.locator('.doc-version-legend-delete')]) {
      await expect(removed).toHaveCSS('color', red);
      await expect(removed).toHaveCSS('text-decoration-line', 'line-through');
    }
    await expect(page.getByTestId('doc-version-row-current')).toHaveCSS('border-top-color', active);
    await expect(row).toHaveCSS('border-top-color', active);
  }
  await setTheme(page, 'light');

  // A fold opens on a click and stays open.
  await page.getByTestId('doc-version-fold').click();
  await expect(page.getByTestId('doc-version-fold')).toHaveCount(0);
  await expect(preview.locator('.doc-version-folded')).toHaveCount(0);
  await expect(preview).toContainText('alpha');
  await page.getByTestId('doc-version-close').click();
});
