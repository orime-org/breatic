// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The mask and sketch tools drawn on the node (inner#1302).
 *
 * What the unit suite cannot reach: the drawing layer laid out and painted by
 * a real browser over a real node, its pixels and its exports, the canvas
 * gestures around it, and a press on Run that goes through the real export,
 * upload and model.
 *
 * The runs at the end call the real models and are billed.
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, type Locator, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openTool, seedNode, setNodeContent, zoomBy } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

/** A public JPEG served with CORS, 400×300. */
const IMAGE = 'https://picsum.photos/id/237/400/300.jpg';

/** A phone photo stored 768×1024 with EXIF orientation 6, upright 1024×768; served by a route below. */
const EXIF_PHOTO = 'https://exif-fixture.test/photo.jpg';
const EXIF_BYTES = readFileSync(join(__dirname, '../fixtures/exif6.jpg'));

let page: Page;
let projectId = '';
let spaceId = '';
let imageNode = '';

/**
 * The node under test.
 * @param id - Its id.
 * @returns The node.
 */
const nodeOf = (id: string): Locator => visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);

/**
 * Drag across the drawing layer from one fraction of it to another.
 * @param layer - The drawing layer.
 * @param from - Start, as fractions of the layer.
 * @param to - End, as fractions of the layer.
 */
async function drawAcross(layer: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await layer.boundingBox();
  if (box === null) throw new Error('the drawing layer has no box');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 10 });
  await page.mouse.up();
}

/**
 * The canvas viewport's transform.
 * @returns Its CSS transform.
 */
async function viewportTransform(): Promise<string> {
  return visibleSpace(page).locator('.react-flow__viewport').evaluate((el) => (el as HTMLElement).style.transform);
}

/**
 * The thickness, in layout pixels, of the ink crossing the middle column of
 * the drawing layer's committed canvas.
 * @param node - The node.
 * @returns The thickness, and the canvas's bitmap width.
 */
async function inkAcrossMiddle(node: Locator): Promise<{ thickness: number; bitmap: number; layout: number }> {
  return node.locator('[data-testid=mini-tool-draw-layer] canvas').first().evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const x = Math.floor(canvas.width / 2);
    const column = ctx.getImageData(x, 0, 1, canvas.height).data;
    let rows = 0;
    // Rows at least half covered, so the anti-aliased edge counts once.
    for (let i = 3; i < column.length; i += 4) if (column[i]! >= 128) rows += 1;
    const layout = canvas.offsetWidth;
    return { thickness: (rows * layout) / canvas.width, bitmap: canvas.width, layout };
  });
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.route(`${EXIF_PHOTO}**`, (route) =>
    route.fulfill({ body: EXIF_BYTES, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' } }),
  );
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `mask-tools-e2e-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  imageNode = randomUUID();
  await seedNode(page, { projectId, spaceId }, imageNode, 'image', 0, {
    content: IMAGE,
    mimeType: 'image/jpeg',
    size: 40_000,
  });
  await expect(nodeOf(imageNode).getByTestId('image-node-img')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

// B2, B4, B5: the layer covers the picture; a left drag draws without moving
// the node; Run waits for ink; undo from the keyboard and the view bar act on
// the drawing.
test('a drag draws on the picture without moving the node, and undo takes it back @needs-internet', async () => {
  await openTool(page, imageNode, 'image.erase');
  const node = nodeOf(imageNode);
  const layer = node.getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  const picture = (await node.getByTestId('image-node-img').boundingBox())!;
  const covered = (await layer.boundingBox())!;
  for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(covered[key] - picture[key])).toBeLessThan(1);

  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeDisabled();
  const placed = await node.evaluate((el) => (el as HTMLElement).style.transform);
  await drawAcross(layer, [0.2, 0.5], [0.8, 0.5]);
  expect(await node.evaluate((el) => (el as HTMLElement).style.transform)).toBe(placed);
  await expect(run).toBeEnabled();

  await page.keyboard.press('ControlOrMeta+z');
  await expect(run).toBeDisabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(run).toBeEnabled();
  const undo = page.getByTestId('viewport-toolbar').getByRole('button').first();
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(run).toBeDisabled();
  await expect(undo).toBeDisabled();
  // Nothing of the drawing was left on the canvas's own history.
  await expect(node).toBeVisible();
});

// B4: wheel over the layer pans the canvas, Ctrl+wheel zooms it.
test('the wheel over the drawing pans and zooms the canvas @needs-internet', async () => {
  await openTool(page, imageNode, 'image.inpaint');
  const layer = nodeOf(imageNode).getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  // The node menu holds scrolling until it has closed.
  await expect(page.getByTestId('node-menu-tools')).toBeHidden();
  const box = (await layer.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await viewportTransform();
  await page.mouse.wheel(0, 120);
  await expect.poll(viewportTransform).not.toBe(before);
  const panned = await viewportTransform();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await expect.poll(viewportTransform).not.toBe(panned);
});

// B3: the ring is as wide as the stroke it lays down at any zoom, and the
// bitmap is painted again at the zoom it settles on, up to the picture's own pixels.
test('the brush ring matches the stroke at 0.5, 1 and 2 times, and zooming in sharpens the ink @needs-internet', async () => {
  await openTool(page, imageNode, 'image.sketch');
  const node = nodeOf(imageNode);
  const layer = node.getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  for (const deltaY of [0, 400, -800]) {
    if (deltaY !== 0) {
      await zoomBy(page, deltaY);
      await page.waitForTimeout(400);
    }
    const clear = page.getByTestId('mini-tool-draw-clear');
    if (await clear.isEnabled()) await clear.click();
    await drawAcross(layer, [0.1, 0.5], [0.9, 0.5]);
    const box = (await layer.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4);
    const ring = await layer.locator('[aria-hidden=true].rounded-full').evaluate((el) => parseFloat((el as HTMLElement).style.width));
    const ink = await inkAcrossMiddle(node);
    // Within a bitmap pixel and a half, as layout pixels.
    expect(Math.abs(ink.thickness - ring)).toBeLessThanOrEqual(Math.max(1, (1.5 * ink.layout) / ink.bitmap));
    const natural = await node.getByTestId('image-node-img').evaluate((el) => (el as HTMLImageElement).naturalWidth);
    const zoom = box.width / ink.layout;
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    expect(Math.abs(ink.bitmap - Math.min(ink.layout * dpr * zoom, natural * dpr))).toBeLessThanOrEqual(2);
  }
});

// §6.4: the painter and the export, pixel by pixel, on the live modules.
test('the export is the upright source with a mask of only 0 and 255, and a wiped drawing has no ink @needs-internet', async () => {
  await openTool(page, imageNode, 'image.inpaint');
  await expect(nodeOf(imageNode).getByTestId('mini-tool-draw-layer')).toBeVisible({ timeout: 15_000 });
  // The resource timeline keeps only the first modules loaded; these two sit
  // beside the canvas module on the same dev server.
  const canvasAt = new URL(await liveModuleUrl(page, CANVAS_SPACE));
  const root = canvasAt.href.slice(0, canvasAt.href.indexOf(CANVAS_SPACE));
  const paintAt = `${root}spaces/canvas/mini-tool/paint-drawing.ts`;
  const exportAt = `${root}spaces/canvas/focus/crop-export.ts`;
  const found = await page.evaluate(
    async ([paintUrl, exportUrl, image, photo]) => {
      const paint = (await import(/* @vite-ignore */ paintUrl)) as typeof import('../../src/spaces/canvas/mini-tool/paint-drawing');
      const exporter = (await import(/* @vite-ignore */ exportUrl)) as typeof import('../../src/spaces/canvas/focus/crop-export');
      const stroke = { kind: 'stroke', erase: false, size: 10, color: '#FF3B30', points: [[0.2, 0.5], [0.8, 0.5]] } as const;
      const wipe = { ...stroke, erase: true, size: 25 } as const;
      const rect = { kind: 'rect', size: 5, color: '#FF3B30', x: 0.25, y: 0.25, w: 0.5, h: 0.5 } as const;
      /**
       * A PNG's pixel size and the set of its red values.
       * @param blob - The PNG.
       * @returns What it holds.
       */
      const read = async (blob: Blob): Promise<{ w: number; h: number; values: number[] }> => {
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
        const values = new Set<number>();
        for (let i = 0; i < data.length; i += 4) values.add(data[i]!);
        return { w: bitmap.width, h: bitmap.height, values: [...values].sort((a, b) => a - b) };
      };
      const mask = await exporter.exportDrawing(image, 'mask', [stroke, rect]);
      const upright = await exporter.exportDrawing(photo, 'mask', [stroke]);
      const sketch = await exporter.exportDrawing(image, 'sketch', [rect]);
      let empty = '';
      try {
        await exporter.exportDrawing(image, 'mask', [stroke, wipe]);
      } catch (err) {
        empty = (err as Error).name;
      }
      return {
        inked: paint.hasInk([stroke], 'mask', 4 / 3),
        wiped: paint.hasInk([stroke, wipe], 'mask', 4 / 3),
        // The same path erased leaves only an anti-aliased rim below half cover.
        retraced: paint.hasInk([stroke, { ...stroke, erase: true }], 'mask', 4 / 3),
        maskSource: await read(mask.image),
        mask: await read(mask.mask!),
        uprightSource: await read(upright.image),
        uprightMask: await read(upright.mask!),
        sketch: { ...(await read(sketch.image)), hasMask: sketch.mask !== undefined },
        empty,
      };
    },
    [paintAt, exportAt, IMAGE, EXIF_PHOTO] as const,
  );
  expect(found.inked).toBe(true);
  expect(found.wiped).toBe(false);
  expect(found.retraced).toBe(false);
  expect([found.maskSource.w, found.maskSource.h]).toEqual([400, 300]);
  expect([found.mask.w, found.mask.h, found.mask.values]).toEqual([400, 300, [0, 255]]);
  expect([found.uprightSource.w, found.uprightSource.h]).toEqual([1024, 768]);
  expect([found.uprightMask.w, found.uprightMask.h]).toEqual([1024, 768]);
  expect([found.sketch.w, found.sketch.h, found.sketch.hasMask]).toEqual([400, 300, false]);
  expect(found.empty).toBe('DrawingEmptyError');
});

// B8: an upload that fails builds nothing.
test('a failed upload of the drawing builds no node @needs-internet', async () => {
  await openTool(page, imageNode, 'image.erase');
  const layer = nodeOf(imageNode).getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await drawAcross(layer, [0.3, 0.3], [0.6, 0.6]);
  await page.route('**/assets/upload-ticket', (route) => route.fulfill({ status: 500, body: '{}' }));
  await page.getByTestId('mini-tool-run').click();
  await expect(page.locator('[data-sonner-toast]')).toBeVisible({ timeout: 60_000 });
  await expect(visibleSpace(page).locator(`.react-flow__node:not([data-id="${imageNode}"])`)).toHaveCount(0);
  await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
});

// B11: a drawing made on the old picture is cleared when the node takes new content.
test('new content on the node clears the drawing and says so @needs-internet', async () => {
  await openTool(page, imageNode, 'image.erase');
  const layer = nodeOf(imageNode).getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await drawAcross(layer, [0.3, 0.3], [0.6, 0.6]);
  await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
  await setNodeContent(page, { projectId, spaceId }, imageNode, 'https://picsum.photos/id/238/600/300.jpg');
  await expect(page.locator('[data-sonner-toast]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('mini-tool-run')).toBeDisabled();
  await expect(page.getByTestId('mini-tool-draw-undo')).toBeDisabled();
});

// B10: a drawing waits in its Space while another is open.
test('the drawing is still there after switching Space and back @needs-internet', async () => {
  await openTool(page, imageNode, 'image.erase');
  const layer = nodeOf(imageNode).getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await drawAcross(layer, [0.3, 0.3], [0.6, 0.6]);
  const other = await createSpace(page, 'canvas', `mask-tools-other-${Date.now()}`);
  try {
    await page.getByTestId(`space-tab-${spaceId}`).click();
    await expect(nodeOf(imageNode).getByTestId('mini-tool-draw-layer')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
  } finally {
    await deleteSpace(page, other);
  }
});

/**
 * Draw on a picture with a tool and run it; the result fills a new node.
 * @param nodeId - The source node.
 * @param toolId - The tool.
 * @param prompt - What to type, for a tool that takes one.
 * @param seeded - Every node already on the canvas.
 * @returns The new node, once its picture has arrived.
 */
async function runOn(nodeId: string, toolId: string, prompt?: string, seeded: string[] = [nodeId]): Promise<Locator> {
  await openTool(page, nodeId, toolId);
  const layer = nodeOf(nodeId).getByTestId('mini-tool-draw-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  await drawAcross(layer, [0.35, 0.35], [0.65, 0.65]);
  if (prompt !== undefined) await page.getByTestId('mini-tool-prompt').fill(prompt);
  await page.getByTestId('mini-tool-run').click();
  const made = visibleSpace(page).locator(
    `.react-flow__node${seeded.map((id) => `:not([data-id="${id}"])`).join('')}`,
  );
  await expect(made).toHaveCount(1, { timeout: 60_000 });
  await expect(made.getByTestId('image-node-img')).toHaveAttribute('src', /^https?:\/\//, { timeout: 300_000 });
  return made;
}

// B7: each tool runs on the real model and fills its node.
test.describe('real runs @needs-internet @billed', () => {
  test.setTimeout(420_000);

  test('inpaint fills a new node', async () => {
    await expect(await runOn(imageNode, 'image.inpaint', 'a red ball')).toContainText('INPAINT-SEED');
  });

  test('erase fills a new node', async () => {
    await expect(await runOn(imageNode, 'image.erase')).toContainText('ERASE-SEED');
  });

  test('sketch edit fills a new node', async () => {
    await expect(await runOn(imageNode, 'image.sketch', 'turn the drawn shape into a red ball')).toContainText(
      'SKETCH-SEED',
    );
  });

  for (const [toolId, prompt] of [
    ['image.erase', undefined],
    ['image.inpaint', 'a red ball'],
  ] as const) {
    test(`${toolId} runs on a phone photo with an EXIF turn`, async () => {
      const photo = randomUUID();
      await seedNode(page, { projectId, spaceId }, photo, 'image', -350, { content: EXIF_PHOTO, mimeType: 'image/jpeg' });
      await expect(await runOn(photo, toolId, prompt, [imageNode, photo])).toContainText('-SEED');
    });
  }
});

