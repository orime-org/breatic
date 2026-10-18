// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The fourth batch of image mini-tools on a real node (inner#1304): multi-angle,
 * relight, restyle and quick edit.
 *
 * What the unit suite cannot reach: the Tools submenu as the canvas opens it,
 * the sphere's card drawing the node's own picture, a picture picked from the
 * canvas into a slot reshaping the relight panel, and each tool's pinned model
 * run for real to a new node downstream (tagged out of the default run).
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomUUID } from 'node:crypto';

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { openTool, seedNode } from '../helpers/mini-tool';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

let page: Page;
let spaceId = '';
let source = '';
let other = '';

/**
 * The node with this id on the visible Space.
 * @param id - The node.
 * @returns Its locator.
 */
function nodeOf(id: string): Locator {
  return visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);
}

/**
 * Pick the other picture into a slot of the open panel.
 * @param testId - The slot's test id.
 */
async function pickOther(testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await nodeOf(other).click();
}

/**
 * Run the open panel and wait for its result, named after the tool, to hold a
 * stored picture.
 * @param prefix - The result's name prefix.
 * @returns The result's picture address.
 */
async function runToResult(prefix: string): Promise<string> {
  const before = await visibleSpace(page).locator('.react-flow__node').count();
  await page.getByTestId('mini-tool-run').click();
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(before + 1, { timeout: 30_000 });
  const result = visibleSpace(page).locator('.react-flow__node', { hasText: `${prefix}-` }).last();
  const picture = result.getByTestId('image-node-img');
  // The model answers in about a minute; the Worker pulling its picture off the
  // provider's CDN has taken six minutes from a local machine.
  await expect(picture).toHaveAttribute('src', /^https?:\/\//, { timeout: 15 * 60_000 });
  return (await picture.getAttribute('src')) ?? '';
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `mini-tools-batch-4-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  source = randomUUID();
  other = randomUUID();
  const picture = (seed: string, w: number, h: number): Record<string, unknown> => ({
    content: `https://picsum.photos/seed/${seed}/${w}/${h}.jpg`,
    mimeType: 'image/jpeg',
    size: 40_000,
  });
  await seedNode(page, { projectId, spaceId }, source, 'image', 0, picture(randomUUID(), 400, 600));
  // Left of the source: results land on its right.
  await seedNode(page, { projectId, spaceId }, other, 'image', -400, picture(randomUUID(), 600, 400));
  await expect(nodeOf(source).getByTestId('image-node-img')).toBeVisible({ timeout: 20_000 });
  await expect(nodeOf(other).getByTestId('image-node-img')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  // A menu left open, on a red case too, would sit over the Space's tab.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

test('the picture tools list quick edit first, set off from the edits below it @needs-internet', async () => {
  await nodeOf(source).click({ button: 'right' });
  await page.getByTestId('node-menu-tools').hover();
  await expect(page.getByTestId('node-menu-tool-image.quickEdit')).toBeVisible();
  const rows = page.getByTestId('node-menu-tool-image.quickEdit').locator('xpath=..').locator(':scope > *');
  const kinds = await rows.evaluateAll((els) => els.slice(0, 3).map((el) => el.getAttribute('data-testid') ?? el.getAttribute('role')));
  expect(kinds).toEqual(['node-menu-tool-image.quickEdit', 'separator', 'node-menu-tool-image.crop']);
  for (const id of ['image.angle', 'image.relight', 'image.restyle']) {
    await expect(page.getByTestId(`node-menu-tool-${id}`)).toBeVisible();
  }
});

test('multi-angle shows the camera sphere with the picture on its card and runs with no note @needs-internet', async () => {
  await openTool(page, source, 'image.angle');
  await expect(page.getByTestId('generate-camera-angle-sphere')).toHaveAttribute('data-card', 'picture', { timeout: 30_000 });
  await expect(page.getByTestId('generate-param-distance-value')).toBeVisible();
  await expect(page.getByTestId('mini-tool-prompt')).toHaveValue('');
  await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
});

test('relight lays the light out on the left, and a reference picture takes the sphere\'s place @needs-internet', async () => {
  await openTool(page, source, 'image.relight');
  const left = page.getByTestId('mini-tool-column-left');
  const right = page.getByTestId('mini-tool-column-right');
  await expect(left.getByTestId('generate-camera-angle-sphere')).toHaveAttribute('data-card', 'picture', { timeout: 30_000 });
  await expect(left.getByTestId('generate-param-light_elevation-stop-90')).toBeVisible();
  await expect(left.getByTestId('generate-param-distance-value')).toHaveCount(0);
  await expect(right.getByTestId('generate-param-light_color-swatch-warm')).toBeVisible();
  await expect(right.getByTestId('generate-param-resolution-option-2k')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('mini-tool-run')).toBeEnabled();

  await pickOther('mini-tool-slot-image.relight-light_reference');
  await expect(left.getByTestId('mini-tool-reference-preview')).toBeVisible({ timeout: 15_000 });
  await expect(left.getByTestId('generate-camera-angle')).toHaveCount(0);
  await expect(right.getByTestId('generate-param-light_color-value')).toContainText('from reference');

  await left.getByTestId('mini-tool-reference-clear').click();
  await expect(left.getByTestId('generate-camera-angle')).toBeVisible();
});

test('restyle holds Run until a style picture is picked @needs-internet', async () => {
  await openTool(page, source, 'image.restyle');
  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeDisabled();
  await expect(page.getByTestId('mini-tool-slot-image.restyle-style')).toHaveAccessibleName('Image (required)');
  await pickOther('mini-tool-slot-image.restyle-style');
  await expect(run).toBeEnabled({ timeout: 15_000 });
});

test('quick edit holds Run until it is told what to change @needs-internet', async () => {
  await openTool(page, source, 'image.quickEdit');
  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeDisabled();
  await page.getByTestId('mini-tool-prompt').fill('make it a rainy night');
  await expect(run).toBeEnabled();
});

test('each tool runs its model to a new picture downstream @needs-internet @needs-model', async () => {
  // Five model runs one after another, each fetched back through the Worker.
  test.setTimeout(60 * 60_000);
  await openTool(page, source, 'image.angle');
  await runToResult('ANGLE');

  await openTool(page, source, 'image.relight');
  await page.getByTestId('generate-param-light_color-swatch-warm').click();
  await runToResult('RELIGHT');

  await openTool(page, source, 'image.relight');
  await pickOther('mini-tool-slot-image.relight-light_reference');
  await expect(page.getByTestId('mini-tool-reference-preview')).toBeVisible({ timeout: 15_000 });
  await runToResult('RELIGHT');

  await openTool(page, source, 'image.restyle');
  await pickOther('mini-tool-slot-image.restyle-style');
  await runToResult('RESTYLE');

  await openTool(page, source, 'image.quickEdit');
  await page.getByTestId('mini-tool-prompt').fill('make it a rainy night');
  await runToResult('EDIT');
});
