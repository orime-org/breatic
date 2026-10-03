// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The style slot of the video Generate panel, end to end (inner#828).
 *
 * What no jsdom test reaches: the pick runs off real clicks on real canvas
 * nodes, the slot's cap comes from the catalog the server serves, and the
 * request is built from the node the collaborative document holds.
 *
 * The submit is intercepted. What is under test is the request this client
 * builds; whether the vendor follows the style images is read off real
 * generations by eye.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { openGenerate, seedNode, registerCanvasStage } from '../helpers/audio-panel';

registerCanvasStage();

// The panel hangs below its node; a taller window keeps its toolbar reachable.
test.use({ viewport: { width: 1440, height: 1400 } });

/**
 * Four distinct pictures the browser can draw: the slot refuses the same
 * picture twice, and a node whose picture fails to load collapses to no height.
 */
const STYLE = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad'].map(
  (fill) =>
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${fill}"/></svg>`,
    )}`,
);

/**
 * Where each picture node goes, relative to the target: one to its left and
 * three above, so the panel, which hangs below the target, covers none.
 */
const STYLE_AT = [
  [-320, 0],
  [-320, -330],
  [0, -330],
  [320, -330],
] as const;

/**
 * Seed an empty video target and four filled image nodes around it.
 *
 * The target goes first: a fresh Space frames the first thing put in it, so
 * the rest is placed relative to where that lands.
 * @returns The target's id and the picture nodes' ids.
 */
async function seedBoard(): Promise<{ target: string; pictures: string[] }> {
  const target = crypto.randomUUID();
  await seedNode(target, 'video', undefined, 0, 0);
  const pictures = STYLE.map(() => crypto.randomUUID());
  for (const [i, id] of pictures.entries()) {
    const [x, y] = STYLE_AT[i];
    await seedNode(id, 'image', STYLE[i], x, y);
  }
  return { target, pictures };
}

/**
 * Set the open video panel's mode and model.
 * @param page - A page with the video panel open.
 * @param mode - The mode's value.
 * @param model - The model's catalog name.
 */
async function choose(page: Page, mode: string, model: string): Promise<void> {
  await page.getByTestId('generate-video-mode-trigger').click();
  await page.getByTestId(`generate-video-mode-${mode}`).click();
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId(`generate-model-option-${model}`).click();
}

/**
 * Click a canvas node while a pick is running.
 * @param page - A page with a pick running.
 * @param nodeId - The node to click.
 */
async function clickNode(page: Page, nodeId: string): Promise<void> {
  await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
}

/**
 * Catch the next task submit and answer it as queued.
 * @param page - The page that will submit.
 * @returns A reader for the body sent, undefined until it is.
 */
async function catchSubmit(page: Page): Promise<() => Record<string, unknown> | undefined> {
  let body: Record<string, unknown> | undefined;
  await page.route('**/canvas/tasks', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });
  return () => body;
}

test('picks up to three style pictures for a text-to-video model and sends them', async ({ page }) => {
  const { target, pictures } = await seedBoard();
  await openGenerate(target, 'generate-video-execute');
  await choose(page, 't2v', 'seedance-2.5-text-to-video');

  const add = page.getByTestId('generate-tool-style');
  await expect(add).toContainText('Style');
  // Text-to-video draws no source slot, so the style area's divider is the row's only one.
  await expect(page.getByTestId('generate-video-tool-style-sep')).toBeVisible();
  const toolRow = page.getByTestId('generate-video-tool-reference').locator('xpath=..');
  await expect(toolRow.getByRole('separator')).toHaveCount(1);

  await add.click();
  await clickNode(page, pictures[0]);
  await expect(page.getByTestId('generate-style-thumbnail-0')).toBeVisible();
  await expect(add).toContainText('1/3');
  await expect(page.locator(`.react-flow__node[data-id="${pictures[0]}"]`)).toHaveClass(/canvas-pick-dimmed/);
  await clickNode(page, pictures[1]);
  await expect(add).toContainText('2/3');
  await clickNode(page, pictures[2]);
  // The third fills the slot: the add place goes and the pick ends.
  await expect(page.getByTestId('generate-style-thumbnail-2')).toBeVisible();
  await expect(add).toHaveCount(0);
  await expect(page.getByTestId('reference-pick-banner')).toHaveCount(0);

  await page.getByTestId('generate-tool-style-item-1').hover();
  await page.getByTestId('generate-style-clear-1').click();
  await expect(add).toContainText('2/3');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('a lighthouse at dusk');
  const sent = await catchSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const params = (sent() as { params: Record<string, unknown> }).params;
  expect(params.style_images).toEqual([STYLE[0], STYLE[2]]);
});

test('a reference-to-video model keeps the style pictures apart from the @ references', async ({ page }) => {
  const { target, pictures } = await seedBoard();
  await openGenerate(target, 'generate-video-execute');
  await choose(page, 'ref', 'wan-3.0-reference-to-video');

  await page.getByTestId('generate-video-tool-reference').click();
  await clickNode(page, pictures[0]);
  const add = page.getByTestId('generate-tool-style');
  await add.click();
  await clickNode(page, pictures[3]);
  await expect(add).toContainText('1/3');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('the scene in ');
  await page.keyboard.type('@');
  await page.getByTestId(`reference-mention-option-${pictures[0]}`).click();
  await page.keyboard.type(' comes to life');
  const sent = await catchSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const params = (sent() as { params: Record<string, unknown> }).params;
  // The worker folds them into the upstream's image list; the client sends them apart.
  expect(params.style_images).toEqual([STYLE[3]]);
  expect(params.images).toEqual([STYLE[0]]);
});

test('style pictures alone do not stand in for a reference', async ({ page }) => {
  const { target, pictures } = await seedBoard();
  await openGenerate(target, 'generate-video-execute');
  await choose(page, 'ref', 'wan-3.0-reference-to-video');

  await page.getByTestId('generate-tool-style').click();
  await clickNode(page, pictures[1]);
  await page.getByTestId('reference-pick-exit').click();

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('a lighthouse at dusk');
  const sent = await catchSubmit(page);
  await page.getByTestId('generate-video-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Still missing', { timeout: 10_000 });
  expect(sent()).toBeUndefined();
});

test('a model without the slot hides it, ends its pick, and the pictures come back', async ({ page }) => {
  const { target, pictures } = await seedBoard();
  await openGenerate(target, 'generate-video-execute');
  await choose(page, 't2v', 'seedance-2.5-text-to-video');

  await page.getByTestId('generate-tool-style').click();
  await clickNode(page, pictures[0]);
  await expect(page.getByTestId('reference-pick-banner')).toBeVisible();

  // Switching to a model that takes no style pictures mid-pick ends the pick.
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-minimax-h3-text-to-video').click();
  await expect(page.getByTestId('generate-tool-style')).toHaveCount(0);
  await expect(page.getByTestId('generate-style-thumbnail-0')).toHaveCount(0);
  await expect(page.getByTestId('generate-video-tool-style-sep')).toHaveCount(0);
  await expect(page.getByTestId('reference-pick-banner')).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Selection ended.');

  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-seedance-2.5-text-to-video').click();
  await expect(page.getByTestId('generate-style-thumbnail-0')).toBeVisible();
  await expect(page.getByTestId('generate-tool-style')).toContainText('1/3');
});
