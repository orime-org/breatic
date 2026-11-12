// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The 3D viewfinder (#1411): frame the scene, capture a still, and send it to
 * the Agent, to a Canvas (with View) and to the clipboard. Each send closes the
 * viewfinder; the still has a 2048-pixel long edge.
 */

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { seedImageNode } from '../helpers/tab-restore';

/**
 * Open the viewfinder, drag the bottom-right corner inward and capture.
 * @param page - The page.
 * @throws {Error} When the capture menu does not appear.
 */
async function frameAndCapture(page: Page): Promise<void> {
  const space = visibleSpace(page);
  await space.getByTestId('scene-viewfinder-trigger').click();
  await expect(space.getByTestId('scene-viewfinder-frame')).toBeVisible();
  await expect(space.getByTestId('scene-map')).toHaveCount(0);
  await expect(space.getByTestId('scene-left-menu')).toHaveCount(0);
  const corner = space.getByTestId('scene-viewfinder-corner-se');
  const box = await corner.boundingBox();
  if (!box) throw new Error('The bottom-right corner is not on screen.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y - 80, { steps: 6 });
  await page.mouse.up();
  const menu = space.getByTestId('scene-viewfinder-menu');
  await expect(menu).toContainText('2048 × 1152');
  await menu.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(menu.getByRole('button', { name: 'Add to Agent', exact: true })).toBeEnabled({ timeout: 15_000 });
}

test('a 3D viewfinder still goes to the Agent, a Canvas and the clipboard @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(180_000);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSmokeProject(page);
  const canvasName = `viewfinder-target-${Date.now()}`;
  const canvasId = await createSpace(page, 'canvas', canvasName);
  // A node far from where the capture lands, so a canvas opening on everything would not centre on the capture.
  await seedImageNode(page, smokeProjectId(), canvasId, { x: 1600, y: 1200 });
  const sceneId = await createSpace(page, '3d', `viewfinder-${Date.now()}`);
  try {
    const space = visibleSpace(page);
    await space.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add block', exact: true }).click();
    await expect(space.getByTestId('three-d-viewport')).toBeVisible();
    // Pull the view back so the floor, where the grid is drawn, fills the lower part of the frame.
    const viewport = await space.getByTestId('three-d-viewport').boundingBox();
    if (!viewport) throw new Error('The viewport is not on screen.');
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    for (let step = 0; step < 6; step += 1) await page.mouse.wheel(0, 400);

    // Agent: the still lands in the tray of the conversation on screen.
    await frameAndCapture(page);
    await space.getByTestId('scene-viewfinder-menu').getByRole('button', { name: 'Add to Agent', exact: true }).click();
    await expect(page.getByText('Added to Agent', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(space.getByTestId('scene-viewfinder-frame')).toHaveCount(0);
    await expect(page.locator('[data-testid^="chat-chip-"][data-status="ready"]').filter({ hasText: '3D-' })).toHaveCount(1);
    await expect(space.getByTestId('scene-map')).toBeVisible();

    // Canvas: the list names the canvas; View opens it, never opened in this browser, with the new
    // node selected in the middle of the view.
    const canvasTab = page.getByTestId(`space-tab-${canvasId}`);
    await canvasTab.hover();
    await canvasTab.getByRole('button', { name: 'Close Space tab' }).click();
    await expect(canvasTab).toHaveCount(0);
    await page.evaluate((id) => {
      const raw = localStorage.getItem('breatic.projectTabs');
      if (raw === null) return;
      /**
       * Drop the stored camera of one Space wherever it is kept.
       * @param value - Part of the stored record.
       */
      const strip = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) return;
        const entry = value as Record<string, unknown>;
        if (entry.spaceId === id) delete entry.viewport;
        Object.values(entry).forEach(strip);
      };
      const record = JSON.parse(raw) as unknown;
      strip(record);
      localStorage.setItem('breatic.projectTabs', JSON.stringify(record));
    }, canvasId);
    await frameAndCapture(page);
    await space.getByTestId('scene-viewfinder-menu').getByRole('button', { name: 'Add to Canvas', exact: true }).click();
    const list = page.getByTestId('scene-viewfinder-canvas-list');
    await list.getByRole('button', { name: canvasName, exact: true }).click();
    const added = page.locator('[data-sonner-toast]').filter({ hasText: `Added to ${canvasName}` });
    await expect(added).toBeVisible({ timeout: 90_000 });
    await expect(space.getByTestId('scene-viewfinder-frame')).toHaveCount(0);
    await added.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.getByTestId(`space-tab-${canvasId}`)).toHaveAttribute('aria-selected', 'true');
    const node = visibleSpace(page).locator('.react-flow__node.selected');
    await expect(node).toHaveCount(1, { timeout: 30_000 });
    const pane = await visibleSpace(page).locator('.react-flow').boundingBox();
    await expect.poll(async () => {
      const box = await node.boundingBox();
      return box && pane ? Math.abs(box.x + box.width / 2 - (pane.x + pane.width / 2)) : Infinity;
    }, { timeout: 5_000 }).toBeLessThan(40);
    await expect(node.locator('img')).toHaveAttribute('src', /^https?:/, { timeout: 60_000 });
    // The node may draw a thumbnail; the stored original is what must be 2048 on its long edge.
    const src = await node.locator('img').getAttribute('src');
    const original = await page.evaluate(async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      return { width: bitmap.width, height: bitmap.height };
    }, (src ?? '').replace(/[?#].*$/, '').replace(/\.preview\.webp$/, ''));
    expect(Math.max(original.width, original.height)).toBe(2048);

    // Clipboard: a PNG.
    await page.getByTestId(`space-tab-${sceneId}`).click();
    await frameAndCapture(page);
    await visibleSpace(page).getByTestId('scene-viewfinder-menu').getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();
    const types = await page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => [...item.types]));
    expect(types).toContain('image/png');
    // The still keeps the scene background and drops the grid: in this pulled-back view the far
    // floor, where the grid's lines bunch together on screen, lies in the top quarter of the frame
    // and the box below it, so every pixel of that quarter is the screen's background colour.
    const pixels = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.drawImage(bitmap, 0, 0);
      const quarter = context.getImageData(0, 0, bitmap.width, Math.floor(bitmap.height / 4)).data;
      const colours = new Set<string>();
      for (let i = 0; i < quarter.length; i += 4) colours.add(`${quarter[i]},${quarter[i + 1]},${quarter[i + 2]}`);
      const probe = document.createElement('div');
      probe.style.color = 'var(--color-canvas)';
      document.body.append(probe);
      const screen = getComputedStyle(probe).color;
      probe.remove();
      return { width: bitmap.width, colours: [...colours], screen };
    });
    expect(pixels.width).toBe(2048);
    expect(pixels.colours).toHaveLength(1);
    expect(pixels.screen.replace(/\s/g, '')).toBe(`rgb(${pixels.colours[0]})`);
  } finally {
    await deleteSpace(page, sceneId);
    await deleteSpace(page, canvasId);
  }
});
