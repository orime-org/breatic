// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The grid tool cut for real (inner#1968 design 3.2.2): since the cut moved
 * from the browser into the media container, a press on Run sends the
 * uploaded source to the ingest Worker, vips cuts the tiles there, and each
 * tile lands on its own result node. The source is uploaded through the
 * canvas, so it is a registered asset the container can read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openTool } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { uniquePicture } from '../helpers/upload';

/** 480×600, so a 2×2 grid cuts four tiles of 240×300. */
const SOURCE = join(__dirname, '../fixtures/portrait.png');

let page: Page;
let projectId = '';
let spaceId = '';

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `grid-container-${String(Date.now())}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

/**
 * Every node's id and content in the canvas document.
 * @returns The nodes.
 */
async function documentNodes(): Promise<{ id: string; type: string; content: string }[]> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; type: string; data?: { content?: string } }[] };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => ({ id: n.id, type: n.type, content: n.data?.content ?? '' }));
    },
    [projectId, spaceId, at] as [string, string, string],
  );
}

/**
 * One pixel of a stored picture, fetched outside the page and drawn from a data URL.
 * @param url - The picture.
 * @param x - Across.
 * @param y - Down.
 * @returns Red, green, blue and alpha.
 */
async function pixelAt(url: string, x: number, y: number): Promise<number[]> {
  const response = await page.request.get(url);
  const src = `data:${response.headers()['content-type'] ?? 'image/png'};base64,${(await response.body()).toString('base64')}`;
  return page.evaluate(
    async ({ data, px, py }) => {
      const img = new Image();
      img.src = data;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('no 2d context');
      context.drawImage(img, 0, 0);
      return [...context.getImageData(px, py, 1, 1).data];
    },
    { data: src, px: x, py: y },
  );
}

test('a 2×2 grid on an uploaded picture lands each container-cut tile on its node @needs-ingest @needs-storage', async () => {
  await page
    .locator('input[data-testid="canvas-upload-input"][multiple]')
    .setInputFiles([{ name: 'grid-source.png', mimeType: 'image/png', buffer: uniquePicture(readFileSync(SOURCE)) }]);
  let source = { id: '', content: '' };
  await expect
    .poll(
      async () => {
        source = (await documentNodes()).find((n) => /^https?:\/\//.test(n.content)) ?? source;
        return source.id;
      },
      { timeout: 120_000, intervals: [1_000] },
    )
    .not.toBe('');

  await openTool(page, source.id, 'image.grid');
  const nodeOf = (id: string): Locator => visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);
  await expect(nodeOf(source.id).getByTestId('mini-tool-grid-layer')).toBeVisible({ timeout: 15_000 });
  for (const axis of ['rows', 'cols']) {
    await page.getByTestId(`mini-tool-param-${axis}-slider`).getByRole('slider').focus();
    await page.keyboard.press('ArrowLeft');
  }
  await expect(nodeOf(source.id).getByTestId('mini-tool-grid-col')).toHaveCount(1);
  await expect(nodeOf(source.id).getByTestId('mini-tool-grid-row')).toHaveCount(1);
  await page.getByTestId('mini-tool-run').click();

  // Every tile node holds a stored picture of its own.
  const tiles = visibleSpace(page).locator(
    `.react-flow__node:not([data-id="${source.id}"]):not(:has([data-testid=group-node]))`,
  );
  await expect(tiles).toHaveCount(4, { timeout: 20_000 });
  const pictures = tiles.getByTestId('image-node-img');
  await expect
    .poll(
      async () => (await pictures.evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''))).filter((src) => /^https?:\/\//.test(src)).length,
      { timeout: 180_000, intervals: [2_000] },
    )
    .toBe(4);
  const urls = await pictures.evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''));
  expect(new Set(urls).size).toBe(4);
  expect(urls).not.toContain(source.content);
  await expect
    .poll(() => pictures.evaluateAll((els) => els.every((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)), { timeout: 30_000 })
    .toBe(true);
  expect(await pictures.evaluateAll((els) => els.map((el) => `${String((el as HTMLImageElement).naturalWidth)}x${String((el as HTMLImageElement).naturalHeight)}`)))
    .toEqual(['240x300', '240x300', '240x300', '240x300']);

  // Each tile is the matching quarter of the source: its centre pixel is the source's there.
  for (const [label, x, y] of [['r1c1', 0, 0], ['r1c2', 240, 0], ['r2c1', 0, 300], ['r2c2', 240, 300]] as const) {
    const tileUrl = await tiles.filter({ hasText: `GRID-${label}-` }).getByTestId('image-node-img').getAttribute('src');
    const tile = await pixelAt(tileUrl ?? '', 120, 150);
    const whole = await pixelAt(source.content, x + 120, y + 150);
    expect(Math.max(...tile.slice(0, 3).map((value, i) => Math.abs(value - whole[i]!))), `tile ${label}`).toBeLessThanOrEqual(3);
  }
});
