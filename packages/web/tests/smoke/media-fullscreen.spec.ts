// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One full-screen view for images and videos (inner#1844): a canvas node and
 * a hover preview open it from a button over the media's top-right corner.
 *
 * The nodes are written straight into the canvas document with data URLs,
 * so no upload is involved.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openGenerate, registerCanvasStage, seedNode } from '../helpers/audio-panel';
import { visibleSpace } from '../helpers/space';
import { smokeProjectId } from '../helpers/project';
import { withTimelinePeer } from '../helpers/timeline-media';

registerCanvasStage();

test.use({ viewport: { width: 1440, height: 1100 } });

const PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#2980b9"/></svg>',
)}`;

const CLIP = `data:video/mp4;base64,${readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')).toString('base64')}`;

/**
 * A node on the visible canvas.
 * @param page - The page.
 * @param id - The node's id.
 * @returns Its locator.
 */
function node(page: Page, id: string): ReturnType<Page['locator']> {
  return visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);
}

test('a canvas picture opens full screen from its top-right corner and keeps dropped files off the canvas', async ({ page }) => {
  const id = crypto.randomUUID();
  await seedNode(id, 'image', PICTURE, 0, 0);
  const picture = node(page, id);
  await expect(picture.getByTestId('image-node-img')).toBeVisible({ timeout: 15_000 });

  const button = picture.getByTestId('media-fullscreen-button');
  await expect(button).toHaveCSS('opacity', '0');
  await picture.hover();
  await expect(button).toHaveCSS('opacity', '1');
  // Over the picture's top-right corner.
  const media = (await picture.getByTestId('node-media-inset').boundingBox())!;
  const at = (await button.boundingBox())!;
  expect(at.x + at.width).toBeLessThanOrEqual(media.x + media.width);
  expect(media.x + media.width - (at.x + at.width)).toBeLessThan(16);
  expect(at.y - media.y).toBeLessThan(16);

  await button.click();
  const layer = page.getByTestId('media-fullscreen');
  await expect(layer.getByTestId('media-fullscreen-image')).toHaveAttribute('src', PICTURE);
  // The close button sits at the viewport's top-right.
  const close = (await page.getByTestId('media-fullscreen-close').boundingBox())!;
  expect(1440 - (close.x + close.width)).toBeLessThanOrEqual(20);
  expect(close.y).toBeLessThanOrEqual(20);

  // A file dropped on the layer does not reach the canvas behind it.
  const before = await visibleSpace(page).locator('.react-flow__node').count();
  // ...and the browser does not open the file in the tab either.
  const taken = await layer.getByTestId('media-fullscreen-image').evaluate((img) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([1, 2, 3])], 'dropped.png', { type: 'image/png' }));
    const box = img.getBoundingClientRect();
    const where = { clientX: box.left + 10, clientY: box.top + 10, bubbles: true, cancelable: true, dataTransfer: transfer };
    return [img.dispatchEvent(new DragEvent('dragover', where)), img.dispatchEvent(new DragEvent('drop', where))];
  });
  expect(taken).toEqual([false, false]);
  await page.waitForTimeout(500);
  expect(await visibleSpace(page).locator('.react-flow__node').count()).toBe(before);

  // Arrows and Esc inside the layer leave the node where it was.
  const placed = await picture.boundingBox();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
  expect(await picture.boundingBox()).toEqual(placed);
});

test('a canvas video goes on full screen from where it was and hands its place back', async ({ page }) => {
  const id = crypto.randomUUID();
  await seedNode(id, 'video', CLIP, 0, 0);
  const clip = node(page, id);
  const inline = clip.locator('video');
  await expect(inline).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => inline.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  await inline.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 0.5;
  });

  await clip.hover();
  await clip.getByTestId('media-fullscreen-button').click();
  const full = page.getByTestId('media-fullscreen').locator('video');
  await expect(full).toBeVisible();
  await expect.poll(() => full.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(0.5, 1);
  expect(await inline.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);

  await full.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1;
  });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('media-fullscreen')).toHaveCount(0);
  expect(await inline.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(1, 1);
});

test('a hover preview opens full screen and stays open when the pointer leaves', async ({ page }) => {
  const target = crypto.randomUUID();
  const style = crypto.randomUUID();
  await seedNode(target, 'image', undefined, 0, 0);
  await seedNode(style, 'image', PICTURE, 600, 0);
  await openGenerate(target, 'generate-execute');
  await page.getByTestId('generate-model-trigger').click();
  await page.getByTestId('generate-model-option-krea-v2-large-text-to-image').click();
  await page.getByTestId('generate-tool-style').click();
  await node(page, style).click();
  await expect(page.getByTestId('generate-style-thumbnail-0')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('generate-tool-style-item-0').hover();
  const card = page.getByTestId('hover-preview-content');
  await expect(card).toBeVisible();
  await card.hover();
  await card.getByTestId('media-fullscreen-button').click();
  await expect(page.getByTestId('media-fullscreen-image')).toHaveAttribute('src', PICTURE);
  await expect(card).toHaveCount(0);

  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('media-fullscreen')).toBeVisible();
  await page.getByTestId('media-fullscreen-close').click();
  await expect(page.getByTestId('media-fullscreen')).toHaveCount(0);
  await expect(card).toHaveCount(0);
});

// inner#1844 round 1: a viewer's canvas neither drags nor selects nodes; the
// button over the picture still answers the pointer.
test('a viewer opens a canvas picture full screen', async ({ page, browser }) => {
  const id = crypto.randomUUID();
  await seedNode(id, 'image', PICTURE, 0, 0);
  await expect(node(page, id).getByTestId('image-node-img')).toBeVisible({ timeout: 15_000 });
  const spaceId = (await visibleSpace(page).getAttribute('data-space-outlet'))!;
  const projectUrl = page.url();

  await withTimelinePeer(page, browser, smokeProjectId(), 'viewer', async (peer) => {
    await peer.goto(projectUrl);
    const tab = peer.getByTestId(`space-tab-name-${spaceId}`);
    if (await tab.count() === 0) {
      await peer.getByTestId('space-drawer-trigger').click();
      await peer.getByTestId('space-drawer').getByTestId(`space-drawer-row-${spaceId}`).getByRole('button', { name: /Open/ }).click();
    } else {
      await tab.click();
    }
    const picture = node(peer, id);
    await expect(picture.getByTestId('image-node-img')).toBeVisible({ timeout: 20_000 });
    // The canvas eases the node into view as it opens; hover once it has settled.
    let last = '';
    await expect.poll(async () => {
      const box = JSON.stringify(await picture.boundingBox());
      const settled = box === last;
      last = box;
      return settled;
    }, { intervals: [200] }).toBe(true);
    await picture.hover();
    const button = picture.getByTestId('media-fullscreen-button');
    await expect(button).toHaveCSS('opacity', '1');
    await button.click();
    await expect(peer.getByTestId('media-fullscreen-image')).toHaveAttribute('src', PICTURE);
    await peer.keyboard.press('Escape');
    await expect(peer.getByTestId('media-fullscreen')).toHaveCount(0);
  });
});

// inner#1844 round 1: beside a narrow picture is backdrop, and a press there closes.
test('a press beside a tall picture closes full screen', async ({ page }) => {
  const tall = `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect width="300" height="900" fill="#27ae60"/></svg>',
  )}`;
  const id = crypto.randomUUID();
  await seedNode(id, 'image', tall, 0, 0);
  const picture = node(page, id);
  await expect(picture.getByTestId('image-node-img')).toBeVisible({ timeout: 15_000 });
  await picture.hover();
  await picture.getByTestId('media-fullscreen-button').click();
  const img = page.getByTestId('media-fullscreen-image');
  await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  await page.mouse.click(box.x - 100, box.y + box.height / 2);
  await expect(page.getByTestId('media-fullscreen')).toHaveCount(0);
});
