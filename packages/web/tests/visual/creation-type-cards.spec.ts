// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { openSmokeProject } from '../helpers/project';

interface Catalog {
  spaces: {
    kind: { canvasSub: string; documentSub: string; threeDSub: string; timelineSub: string };
    create: { notAvailable: string; cancel: string };
  };
  studio: { container: { projects: { new: string }; dialog: { cancel: string } } };
}

/**
 * Check the shared control through its rendered geometry and real hover/focus paths.
 * @throws {Error} When a card overflows, its description is missing or keyboard selection fails.
 */
async function checkCards(page: Page, dialog: Locator, prefix: string, catalog: Catalog, sample: string): Promise<void> {
  const group = dialog.getByRole('radiogroup');
  await expect(group.getByRole('radio')).toHaveText(['Canvas', 'Document', '3D', 'Timeline']);
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const layout = await group.evaluate((element) => {
    const groupRect = element.getBoundingClientRect();
    return {
      available: element.clientWidth,
      content: element.scrollWidth,
      left: groupRect.left,
      right: groupRect.right,
      cards: [...element.querySelectorAll('[role="radio"]')].map((card) => {
        const rect = card.getBoundingClientRect();
        return { width: rect.width, top: rect.top, left: rect.left, right: rect.right };
      }),
    };
  });
  expect(layout.content).toBeLessThanOrEqual(layout.available);
  for (const card of layout.cards) {
    expect(card.top).toBeCloseTo(layout.cards[0].top, 2);
    expect(card.width).toBeCloseTo(layout.cards[0].width, 2);
    expect(card.left).toBeGreaterThanOrEqual(layout.left - 1);
    expect(card.right).toBeLessThanOrEqual(layout.right + 1);
  }
  const marker = group.getByText('DEV', { exact: true });
  await expect(marker).toHaveCount(1);
  await expect(marker).toBeVisible();
  const threeD = dialog.getByTestId(`${prefix}-3d`);
  const markerBox = await marker.boundingBox();
  const threeDBox = await threeD.boundingBox();
  const iconBox = await threeD.locator('svg').boundingBox();
  const titleBox = await threeD.getByText('3D', { exact: true }).boundingBox();
  if (!markerBox || !threeDBox || !iconBox || !titleBox) throw new Error('The 3D development marker and card content must have visible bounds');
  expect(markerBox.x).toBeGreaterThanOrEqual(threeDBox.x);
  expect(markerBox.y).toBeGreaterThanOrEqual(threeDBox.y);
  expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(threeDBox.x + threeDBox.width);
  expect(markerBox.y + markerBox.height).toBeLessThanOrEqual(threeDBox.y + threeDBox.height);
  expect(markerBox.x + markerBox.width / 2).toBeGreaterThan(threeDBox.x + threeDBox.width / 2);
  expect(markerBox.y + markerBox.height / 2).toBeLessThan(threeDBox.y + threeDBox.height / 2);
  for (const content of [iconBox, titleBox]) {
    const overlapWidth = Math.max(0, Math.min(markerBox.x + markerBox.width, content.x + content.width) - Math.max(markerBox.x, content.x));
    const overlapHeight = Math.max(0, Math.min(markerBox.y + markerBox.height, content.y + content.height) - Math.max(markerBox.y, content.y));
    expect(overlapWidth * overlapHeight).toBe(0);
  }
  await test.info().attach(`${sample}-dev-marker-layout`, {
    body: JSON.stringify({ marker: markerBox, card: threeDBox, icon: iconBox, title: titleBox }),
    contentType: 'application/json',
  });
  await test.info().attach(`${sample}-layout`, { body: JSON.stringify(layout), contentType: 'application/json' });
  const screenshot = test.info().outputPath(`${sample}.png`);
  await page.screenshot({ path: screenshot });
  await test.info().attach(sample, { path: screenshot, contentType: 'image/png' });
  const descriptions = [
    ['canvas', catalog.spaces.kind.canvasSub],
    ['document', catalog.spaces.kind.documentSub],
    ['3d', catalog.spaces.kind.threeDSub],
    ['timeline', catalog.spaces.kind.timelineSub],
  ] as const;
  for (const [kind, description] of descriptions) {
    const card = dialog.getByTestId(`${prefix}-${kind}`);
    await page.mouse.move(0, 0, { steps: 8 });
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await card.hover();
    await expect(page.getByRole('tooltip')).toContainText(description);
    if (kind === 'timeline') {
      await expect(page.getByRole('tooltip')).toContainText(catalog.spaces.create.notAvailable);
      await expect(card).toHaveAttribute('aria-disabled', 'true');
    }
  }
  await page.mouse.move(0, 0, { steps: 8 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await dialog.getByTestId(`${prefix}-canvas`).press('Tab');
  await expect(dialog.getByTestId(`${prefix}-document`)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId(`${prefix}-document`)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Tab');
  await expect(dialog.getByTestId(`${prefix}-3d`)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog.getByTestId(`${prefix}-3d`)).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Tab');
  const timeline = dialog.getByTestId(`${prefix}-timeline`);
  await expect(timeline).toBeFocused();
  const timelineTooltip = page.getByRole('tooltip', {
    name: `${catalog.spaces.kind.timelineSub} · ${catalog.spaces.create.notAvailable}`,
    exact: true,
  });
  await expect(timelineTooltip).toBeVisible();
  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key);
    await expect(timeline).toHaveAttribute('aria-checked', 'false');
    await expect(dialog.getByTestId(`${prefix}-3d`)).toHaveAttribute('aria-checked', 'true');
  }
  // A real mouse press reaches aria-disabled options without an actionability override.
  await timeline.hover();
  await page.mouse.down();
  await page.mouse.up();
  await expect(timeline).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByTestId(`${prefix}-3d`)).toHaveAttribute('aria-checked', 'true');
}

test.use({ viewport: { width: 1440, height: 1000 } });

test('Project and Space type cards fit one row and expose localized hover descriptions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  await page.goto('/studio');
  const studios = await dataOf<Array<{ slug: string; type: string }>>(await page.request.get('/api/v1/studios'), 'list own Studios');
  const studio = studios.find((item) => item.type === 'personal');
  if (!studio) throw new Error('The slot account has no personal Studio');
  try {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      const catalog = JSON.parse(readFileSync(join(__dirname, '../../../../locales', `${locale}.json`), 'utf8')) as Catalog;
      for (const theme of ['light', 'dark']) {
        await page.goto(`/studio/${studio.slug}`);
        await page.getByTestId('lang-trigger').click();
        await page.getByTestId(`lang-option-${locale}`).click();
        await page.getByTestId('theme-toggle').click();
        await page.getByTestId(`theme-option-${theme}`).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByTestId('container-toolbar').getByRole('button', { name: catalog.studio.container.projects.new, exact: true }).click();
        const projectDialog = page.getByTestId('new-project-dialog');
        await checkCards(page, projectDialog, 'new-project-type', catalog, `project-${locale}-${theme}`);
        await projectDialog.getByRole('button', { name: catalog.studio.container.dialog.cancel, exact: true }).click();
        await expect(projectDialog).toHaveCount(0);
        await openSmokeProject(page);
        await page.getByTestId('new-space-button').click();
        const spaceDialog = page.getByTestId('new-space-dialog');
        await checkCards(page, spaceDialog, 'new-space-type', catalog, `space-${locale}-${theme}`);
        await spaceDialog.getByRole('button', { name: catalog.spaces.create.cancel, exact: true }).click();
        await expect(spaceDialog).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await page.keyboard.press('Escape');
    await page.goto(`/studio/${studio.slug}`);
    await page.getByTestId('lang-trigger').click();
    await page.getByTestId('lang-option-en').click();
  }
});
