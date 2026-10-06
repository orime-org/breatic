// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The style slot of the image Generate panel, end to end (inner#826).
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
import { visibleSpace } from '../helpers/space';

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
 * Where each style node goes, relative to the target: one to its left and
 * three above, so the panel, which hangs below the target, covers none.
 */
const STYLE_AT = [
  [-320, 0],
  [-320, -330],
  [0, -330],
  [320, -330],
] as const;

/**
 * Seed an empty target and four filled image nodes around it.
 *
 * The target goes first: a fresh Space frames the first thing put in it, so
 * the rest is placed relative to where that lands.
 * @returns The target's id and the filled nodes' ids.
 */
async function seedBoard(): Promise<{ target: string; styles: string[] }> {
  const target = crypto.randomUUID();
  await seedNode(target, 'image', undefined, 0, 0);
  const styles = STYLE.map(() => crypto.randomUUID());
  for (const [i, id] of styles.entries()) {
    const [x, y] = STYLE_AT[i];
    await seedNode(id, 'image', STYLE[i], x, y);
  }
  return { target, styles };
}

/**
 * Pick the open panel's model.
 * @param page - A page with the image panel open.
 * @param name - The model's catalog name.
 */
async function chooseModel(page: Page, name: string): Promise<void> {
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId(`generate-model-option-${name}`).click();
}

/**
 * Click a canvas node while a pick is running.
 * @param page - A page with a pick running.
 * @param nodeId - The node to click.
 */
async function clickNode(page: Page, nodeId: string): Promise<void> {
  await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).click();
}

/**
 * How wide a clear button takes clicks: the widest run of points across its
 * centre line that land on it, probed pixel by pixel outward from the centre.
 * @param page - A page showing the button.
 * @param testId - The button's test id.
 * @returns The width in CSS pixels.
 */
async function clearHitSize(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el === null) return 0;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x: number): boolean => el.contains(document.elementFromPoint(x, cy));
    let left = 0;
    while (hits(cx - left - 1)) left += 1;
    let right = 0;
    while (hits(cx + right + 1)) right += 1;
    return left + right + 1;
  }, testId);
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

test('picks up to three style pictures off the canvas and sends them', async ({ page }) => {
  const { target, styles } = await seedBoard();
  await openGenerate(target, 'generate-execute');
  await chooseModel(page, 'krea-v2-large-text-to-image');

  const add = page.getByTestId('generate-tool-style');
  await expect(add).toContainText('Style');
  await expect(page.getByTestId('generate-tool-sep')).toBeVisible();

  // One click starts the pick; each canvas click adds one picture.
  await add.click();
  await clickNode(page, styles[0]);
  await expect(page.getByTestId('generate-style-thumbnail-0')).toBeVisible();
  await expect(add).toContainText('1/3');
  // A picture already in the slot is no candidate.
  await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${styles[0]}"]`)).toHaveClass(/canvas-pick-dimmed/);
  await clickNode(page, styles[1]);
  await expect(add).toContainText('2/3');
  await expect(page.getByTestId('reference-pick-banner')).toBeVisible();
  await clickNode(page, styles[2]);
  // The third fills the slot: the add button goes and the pick ends.
  await expect(page.getByTestId('generate-style-thumbnail-2')).toBeVisible();
  await expect(add).toHaveCount(0);
  await expect(page.getByTestId('reference-pick-banner')).toHaveCount(0);
  // Each X takes clicks over at least 24x24 (WCAG 2.2 SC 2.5.8), though it draws 16px.
  for (const i of [0, 1, 2]) {
    expect(await clearHitSize(page, `generate-style-clear-${i}`), `clear ${i}`).toBeGreaterThanOrEqual(24);
  }
  // A full slot has no room, so its thumbnails open no pick.
  await page.getByTestId('generate-tool-style-item-0').click();
  await expect(page.getByTestId('reference-pick-banner')).toHaveCount(0);

  // Removing the middle one leaves the other two in order and offers the add again.
  await page.getByTestId('generate-tool-style-item-1').hover();
  await page.getByTestId('generate-style-clear-1').click();
  await expect(add).toContainText('2/3');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('a lighthouse at dusk');
  const sent = await catchSubmit(page);
  await page.getByTestId('generate-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const params = (sent() as { params: Record<string, unknown> }).params;
  expect(params.style_images).toEqual([STYLE[0], STYLE[2]]);
});

test('a model that needs a style picture refuses to run without one', async ({ page }) => {
  const { target } = await seedBoard();
  await openGenerate(target, 'generate-execute');
  await chooseModel(page, 'recraft-v4-style-text-to-image');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('a lighthouse at dusk');
  await page.getByTestId('generate-execute').click();
  await expect(page.locator('[data-sonner-toast]').first()).toContainText('Pick a style image first', {
    timeout: 10_000,
  });
});

test('a model that takes no style pictures shows no style area', async ({ page }) => {
  const { target } = await seedBoard();
  await openGenerate(target, 'generate-execute');
  await chooseModel(page, 'gpt-image-2.5-sunburst-text-to-image');

  await expect(page.getByTestId('generate-tool-reference')).toBeVisible();
  await expect(page.getByTestId('generate-tool-style')).toHaveCount(0);
  await expect(page.getByTestId('generate-tool-sep')).toHaveCount(0);
});

test('an edit model keeps the style pictures apart from the pictures it edits', async ({ page }) => {
  const { target, styles } = await seedBoard();
  await openGenerate(target, 'generate-execute');
  await page.getByTestId('generate-mode-trigger').click();
  await page.getByTestId('generate-mode-i2i').click();
  await chooseModel(page, 'gpt-image-2.5-sunburst-edit');

  // The picture to edit: wired in through Reference and named with @.
  await page.getByTestId('generate-tool-reference').click();
  await clickNode(page, styles[0]);
  const add = page.getByTestId('generate-tool-style');
  await add.click();
  await clickNode(page, styles[3]);
  await expect(add).toContainText('1/3');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('make ');
  await page.keyboard.type('@');
  await page.getByTestId(`reference-mention-option-${styles[0]}`).click();
  await page.keyboard.type('night');
  const sent = await catchSubmit(page);
  await page.getByTestId('generate-execute').click();
  await expect.poll(sent, { timeout: 20_000 }).toBeDefined();
  const params = (sent() as { params: Record<string, unknown> }).params;
  // The worker folds them into the upstream's image list; the client sends them apart.
  expect(params.style_images).toEqual([STYLE[3]]);
  expect(params.images).toEqual([STYLE[0]]);
});
