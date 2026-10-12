// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The third batch of image mini-tools on a real node (inner#1303): the picture
 * adjust, markup, the grid cut and the expand.
 *
 * What the unit suite cannot reach: Fabric drawing on a real canvas inside a
 * real node, the pointer reaching it through the canvas's transform, and a
 * press on Run that builds the nodes downstream and fills them through the
 * real upload — sixty-four of them at once for an 8×8 grid. The expand runs
 * the pinned model for real and is tagged out of the default run.
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomUUID } from 'node:crypto';

import { test, expect, type Locator, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { openTool, seedNode, zoomBy } from '../helpers/mini-tool';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

/**
 * A public JPEG served with CORS, 400×300, so the browser can draw it onto a
 * canvas and export it. Each case draws a picture of its own: tiles already
 * stored by another case would be taken from storage without a transfer.
 */
let image = '';

let page: Page;
let projectId = '';
let spaceId = '';
let imageNode = '';

/**
 * The node with this id on the visible Space.
 * @param id - The node.
 * @returns Its locator.
 */
function nodeOf(id: string): Locator {
  return visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);
}

/** The result nodes: every node but the source and groups. */
function results(): Locator {
  return visibleSpace(page).locator(
    `.react-flow__node:not([data-id="${imageNode}"]):not(:has([data-testid=group-node]))`,
  );
}

/**
 * The pixel sizes of the result pictures, read off the loaded images.
 * @returns Their widths and heights.
 */
async function resultSizes(): Promise<{ width: number; height: number }[]> {
  const pictures = results().getByTestId('image-node-img');
  await expect
    .poll(() => pictures.evaluateAll((els) => els.every((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)), { timeout: 30_000 })
    .toBe(true);
  return pictures.evaluateAll((els) =>
    els.map((el) => ({ width: (el as HTMLImageElement).naturalWidth, height: (el as HTMLImageElement).naturalHeight })),
  );
}

/**
 * Drag with the left button between two fractions of an element.
 * @param target - The element.
 * @param from - Start, as fractions of it.
 * @param to - End, as fractions of it.
 */
async function dragAcross(target: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('nothing to drag across');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/**
 * Click at a fraction of an element.
 * @param target - The element.
 * @param at - Where, as fractions of it.
 */
async function clickAt(target: Locator, at: [number, number]): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('nothing to click');
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
}

/**
 * Step a panel slider with the keyboard.
 * @param testId - The slider's test id.
 * @param key - The key.
 * @param times - How many presses.
 */
async function stepSlider(testId: string, key: 'ArrowRight' | 'ArrowLeft', times: number): Promise<void> {
  await page.getByTestId(testId).getByRole('slider').focus();
  for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
}

/**
 * The alpha of one pixel of a stored picture. The bytes are fetched outside the
 * page, since the store answers a page's fetch without CORS headers, and drawn
 * from a data URL.
 * @param url - The picture.
 * @param x - Across, in its pixels.
 * @param y - Down, in its pixels.
 * @returns The alpha, 0 to 255.
 */
async function pixelAlpha(url: string, x: number, y: number): Promise<number> {
  const response = await page.request.get(url);
  const dataUrl = `data:${response.headers()['content-type'] ?? 'image/png'};base64,${(await response.body()).toString('base64')}`;
  return page.evaluate(
    async ({ src, px, py }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d context');
      context.drawImage(img, 0, 0);
      return context.getImageData(px, py, 1, 1).data[3] ?? 0;
    },
    { src: dataUrl, px: x, py: y },
  );
}

/**
 * Wait for every result to hold a stored picture and give their addresses.
 * @param count - How many results.
 * @returns Their picture addresses.
 */
async function storedResults(count: number): Promise<string[]> {
  await expect(results()).toHaveCount(count, { timeout: 20_000 });
  const pictures = results().getByTestId('image-node-img');
  await expect
    .poll(async () => (await pictures.evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''))).filter((src) => /^https?:\/\//.test(src)).length, { timeout: 120_000 })
    .toBe(count);
  return pictures.evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''));
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `mini-tools-batch-3-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  imageNode = randomUUID();
  image = `https://picsum.photos/seed/${randomUUID()}/400/300.jpg`;
  await seedNode(page, { projectId, spaceId }, imageNode, 'image', 0, { content: image, mimeType: 'image/jpeg', size: 40_000 });
  await expect(nodeOf(imageNode).getByTestId('image-node-img')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

test('the picture adjust previews on the node, resets, and Run fills a picture of the source size @needs-internet', async () => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openTool(page, imageNode, 'image.adjust');
  const layer = nodeOf(imageNode).getByTestId('mini-tool-adjust-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeDisabled();

  await stepSlider('mini-tool-adjust-exposure-slider', 'ArrowRight', 20);
  await expect(page.getByTestId('mini-tool-adjust-exposure-value')).toHaveText('20');
  await expect(run).toBeEnabled();
  await page.getByTestId('mini-tool-adjust-reset').click();
  await expect(page.getByTestId('mini-tool-adjust-exposure-value')).toHaveText('0');
  await expect(run).toBeDisabled();

  await stepSlider('mini-tool-adjust-contrast-slider', 'ArrowRight', 30);
  // The preview draws the picture: its middle is not empty, and nothing threw.
  await expect
    .poll(() =>
      layer.evaluate((el) => {
        const canvas = el as HTMLCanvasElement;
        return canvas.getContext('2d')?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3] ?? 0;
      }),
    )
    .toBe(255);
  expect(errors).toEqual([]);
  await run.click();
  await storedResults(1);
  await expect(results()).toContainText('ADJUST-');
  expect(await resultSizes()).toEqual([{ width: 400, height: 300 }]);
});

test('markup draws, goes back to select, keeps Escape for itself, and Run fills a picture of the source size @needs-internet', async () => {
  await openTool(page, imageNode, 'image.mark');
  const layer = nodeOf(imageNode).getByTestId('mini-tool-mark-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeDisabled();
  await expect(page.getByTestId('mini-tool-mark-select')).toHaveAttribute('aria-pressed', 'true');

  // A rectangle: one object, selected, and the tool back on select.
  await page.getByTestId('mini-tool-mark-rect').click();
  await dragAcross(layer, [0.2, 0.2], [0.5, 0.5]);
  await expect(layer).toHaveAttribute('data-objects', '1');
  await expect(page.getByTestId('mini-tool-mark-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(run).toBeEnabled();

  // Delete takes the selected object, not the node.
  await page.keyboard.press('Delete');
  await expect(layer).toHaveAttribute('data-objects', '0');
  await expect(nodeOf(imageNode)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(layer).toHaveAttribute('data-objects', '1');

  // A text typed in place; Escape leaves the edit and then the selection, and the panel stays.
  await page.getByTestId('mini-tool-mark-text').click();
  await clickAt(layer, [0.6, 0.7]);
  await page.keyboard.type('look here');
  await page.keyboard.press('Escape');
  await expect(layer).toHaveAttribute('data-objects', '2');
  await expect(run).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(run).toBeVisible();

  // The node did not move under the drags.
  await run.click();
  const [marked] = await storedResults(1);
  await expect(results()).toContainText('MARK-');
  expect(await resultSizes()).toEqual([{ width: 400, height: 300 }]);
  // The picture fills the whole result, its far corner included.
  expect(await pixelAlpha(marked!, 390, 290)).toBe(255);
});

test('a 2×2 grid cuts four tiles of the source into a group @needs-internet', async () => {
  await openTool(page, imageNode, 'image.grid');
  await expect(nodeOf(imageNode).getByTestId('mini-tool-grid-layer')).toBeVisible({ timeout: 15_000 });
  await stepSlider('mini-tool-param-rows-slider', 'ArrowLeft', 1);
  await stepSlider('mini-tool-param-cols-slider', 'ArrowLeft', 1);
  await expect(nodeOf(imageNode).getByTestId('mini-tool-grid-col')).toHaveCount(1);
  await expect(nodeOf(imageNode).getByTestId('mini-tool-grid-row')).toHaveCount(1);

  await page.getByTestId('mini-tool-run').click();
  await storedResults(4);
  expect(await resultSizes()).toEqual(Array.from({ length: 4 }, () => ({ width: 200, height: 150 })));
  const group = visibleSpace(page).getByTestId('group-node');
  await expect(group).toHaveCount(1);
  await expect(group.getByTestId('group-name')).toContainText('GRID-');
  await expect(results()).toContainText(['GRID-r1c1-', 'GRID-r1c2-', 'GRID-r2c1-', 'GRID-r2c2-']);
});

// A13: the group and its tiles are on the canvas at the press, and the
// uploader sees each tile wait until the server answers.
test('a grid shows its group and waiting tiles before the tickets come back @needs-internet', async () => {
  await openTool(page, imageNode, 'image.grid');
  await stepSlider('mini-tool-param-rows-slider', 'ArrowLeft', 1);
  await stepSlider('mini-tool-param-cols-slider', 'ArrowLeft', 1);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/assets/upload-ticket*', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByTestId('mini-tool-run').click();
  await expect(visibleSpace(page).getByTestId('group-node')).toHaveCount(1, { timeout: 5_000 });
  await expect(results().getByTestId('node-upload-skeleton')).toHaveCount(4, { timeout: 5_000 });
  release();
  await page.unroute('**/assets/upload-ticket*');
  await expect(results().getByTestId('node-upload-skeleton')).toHaveCount(0, { timeout: 30_000 });
  await storedResults(4);
});

test('a grid tile whose upload failed uploads again on Retry @needs-internet', async () => {
  await openTool(page, imageNode, 'image.grid');
  await stepSlider('mini-tool-param-rows-slider', 'ArrowLeft', 1);
  await stepSlider('mini-tool-param-cols-slider', 'ArrowLeft', 1);
  // Every transfer to the ingest Worker is cut, so each tile fails as an
  // upload that stopped before it finished.
  let cut = 0;
  await page.route('**/uploads**', (route) => {
    cut += 1;
    return route.abort('connectionfailed');
  });
  await page.getByTestId('mini-tool-run').click();
  await expect(results()).toHaveCount(4, { timeout: 20_000 });
  await expect.poll(() => cut, { timeout: 60_000 }).toBeGreaterThan(0);
  const tile = results().first();
  const failed = tile.getByTestId('task-count-failed');
  await expect(failed).toBeVisible({ timeout: 60_000 });
  await page.unroute('**/uploads**');

  await failed.click();
  await page.getByTestId('node-task-row').first().getByTestId('task-action-retry').click();
  await expect(tile.getByTestId('image-node-img')).toHaveAttribute('src', /^https?:\/\//, { timeout: 60_000 });
});

test('a 1×1 grid cannot be run @needs-internet', async () => {
  await openTool(page, imageNode, 'image.grid');
  await stepSlider('mini-tool-param-rows-slider', 'ArrowLeft', 2);
  await stepSlider('mini-tool-param-cols-slider', 'ArrowLeft', 2);
  await expect(page.getByTestId('mini-tool-run')).toBeDisabled();
});

test('an 8×8 grid uploads all sixty-four tiles @needs-internet', async () => {
  test.setTimeout(300_000);
  await openTool(page, imageNode, 'image.grid');
  await stepSlider('mini-tool-param-rows-slider', 'ArrowRight', 5);
  await stepSlider('mini-tool-param-cols-slider', 'ArrowRight', 5);
  await page.getByTestId('mini-tool-run').click();
  // The canvas draws only the nodes in view and keeps the reader's zoom, so
  // zoom out until the whole group is in view.
  await expect(visibleSpace(page).getByTestId('group-node')).toHaveCount(1, { timeout: 20_000 });
  for (let i = 0; i < 4; i += 1) await zoomBy(page, 600);
  const urls = await storedResults(64);
  expect(new Set(urls).size).toBe(64);
});

test('the expand grows past the picture and runs the model to a larger picture @needs-internet @needs-model', async () => {
  test.setTimeout(300_000);
  await openTool(page, imageNode, 'image.expand');
  const frame = nodeOf(imageNode).getByTestId('mini-tool-expand-frame');
  await expect(frame).toBeVisible({ timeout: 15_000 });
  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeDisabled();

  // Pull the right edge out by half the picture's width.
  const handle = nodeOf(imageNode).getByTestId('mini-tool-expand-handle-e');
  const grip = await handle.boundingBox();
  const shown = await frame.boundingBox();
  if (grip === null || shown === null) throw new Error('no handle or frame');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + shown.width / 2, grip.y + grip.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(run).toBeEnabled();

  await run.click();
  await storedResults(1);
  await expect(results()).toContainText('EXPAND-');
  const [size] = await resultSizes();
  expect(size!.width).toBeGreaterThan(400);
});
