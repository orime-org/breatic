// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { openTool, seedNode } from '../helpers/mini-tool';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Drags a real pointer by a measured screen delta.
 * @param page - The signed-in app page.
 * @param target - The handle or media to grab.
 * @param dx - Horizontal screen pixels.
 * @param dy - Vertical screen pixels.
 * @throws {Error} When the target has no layout box.
 */
async function dragCenter(page: Page, target: Locator, dx: number, dy: number): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('Drag target has no layout box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
  await page.mouse.up();
}

test('expand moves its background while source pixels and node geometry stay fixed', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'canvas', `expand-background-${randomUUID()}`);
  try {
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('No canvas context');
      context.fillStyle = '#765b39';
      context.fillRect(0, 0, 400, 300);
      context.fillStyle = '#dcb76c';
      context.fillRect(40, 40, 120, 160);
      return canvas.toDataURL('image/png');
    });
    const nodeId = randomUUID();
    await seedNode(page, { projectId: smokeProjectId(), spaceId }, nodeId, 'image', 240, { content: source, name: 'Expand source' });
    await openTool(page, nodeId, 'image.expand');
    const frame = visibleSpace(page).getByTestId('mini-tool-expand-frame');
    const image = frame.getByTestId('mini-tool-expand-source');
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(image).toBeVisible();
    const originalImage = await image.boundingBox();
    const originalNode = await node.boundingBox();
    expect(originalImage).not.toBeNull();
    expect(originalNode).not.toBeNull();

    await dragCenter(page, frame.getByTestId('mini-tool-expand-handle-e'), 120, 0);
    await dragCenter(page, frame.getByTestId('mini-tool-expand-handle-s'), 0, 90);
    await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
    const before = await frame.boundingBox();
    if (before === null || originalImage === null) throw new Error('Expanded frame is missing');
    const start = { x: originalImage.x + originalImage.width + 20, y: originalImage.y + 30 };
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), start);
    expect(hit).toBe('mini-tool-expand-frame');
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 20, start.y - 15, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => {
      const current = await frame.boundingBox();
      return current === null ? null : { x: Math.round(current.x - before.x), y: Math.round(current.y - before.y), width: Math.round(current.width - before.width), height: Math.round(current.height - before.height) };
    }).toEqual({ x: -20, y: -15, width: 0, height: 0 });
    expect(await image.boundingBox()).toEqual(originalImage);
    expect(await node.boundingBox()).toEqual(originalNode);
    const moved = await frame.boundingBox();
    await dragCenter(page, image, 20, 15);
    expect(await frame.boundingBox()).toEqual(moved);
    expect(await image.boundingBox()).toEqual(originalImage);
    expect(await node.boundingBox()).toEqual(originalNode);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath('expand-background.png') });
  } catch (error) {
    await page.screenshot({ path: info.outputPath('expand-background-failure.png') });
    throw error;
  } finally {
    await deleteSpace(page, spaceId);
  }
});
