// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Route } from 'playwright/test';
import { test } from '../helpers/slot';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { roomForUploads } from '../helpers/upload-budget';

test('an upload keeps its Space busy across switching and clears after refusal', async ({ page }) => {
  const errors: string[] = [];
  const made: string[] = [];
  const held: Route[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/assets/upload-ticket*', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    held.push(route);
  });
  try {
    await openSmokeProject(page);
    const canvas = await createSpace(page, 'canvas', `busy-upload-${Date.now()}`);
    made.push(canvas);
    const document = await createSpace(page, 'document', `busy-other-${Date.now()}`);
    made.push(document);
    const canvasTab = page.getByTestId(`space-tab-${canvas}`);
    const otherTab = page.getByTestId(`space-tab-${document}`);
    const busy = page.getByTestId(`space-tab-busy-${canvas}`);
    await canvasTab.click();
    await expect(visibleSpace(page).locator('.react-flow__pane')).toBeVisible();
    await roomForUploads(1);
    await page.locator('input[data-testid="canvas-upload-input"][multiple]').setInputFiles({
      name: `busy-${Date.now()}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    });
    await expect.poll(() => held.length).toBe(1);
    await expect(busy).toBeVisible();
    await otherTab.click();
    await expect(otherTab).toHaveAttribute('aria-selected', 'true');
    await expect(busy).toBeVisible();
    await expect(page.getByTestId(`space-tab-busy-${document}`)).toHaveCount(0);
    await canvasTab.hover();
    await page.getByTestId(`space-tab-close-${canvas}`).click();
    await expect(canvasTab).toBeVisible();
    await expect(busy).toBeVisible();
    for (const route of held.splice(0)) {
      await route.fulfill({ status: 400, json: { error: { code: 'TEST_REFUSAL', message: 'Upload refused by the test' } } });
    }
    await expect(busy).toHaveCount(0);
    await canvasTab.click();
    await expect(canvasTab).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
  } finally {
    for (const route of held.splice(0)) {
      await route.fulfill({ status: 400, json: { error: { code: 'TEST_REFUSAL', message: 'Test cleanup' } } });
    }
    for (const id of made.reverse()) await deleteSpace(page, id);
  }
});
