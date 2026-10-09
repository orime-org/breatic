// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The crop box drawn inside the node, and the browser mini-tools that use it
 * (inner#888 §7.4.1, §7.5).
 *
 * What the unit suite cannot reach: the box laid out by a real browser inside
 * a real node — its handles at their screen size whatever the zoom — and a
 * press on Run that builds the node downstream and fills it through the real
 * upload. The focus crop shares the same box, so it is walked here too.
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 */
import { randomUUID } from 'node:crypto';

import { test, expect, type Locator, type Page } from 'playwright/test';

import { CANVAS_SPACE, YJS_MANAGER, liveModuleUrl } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

/** A public JPEG served with CORS, so the browser can draw it onto a canvas and export it. */
const IMAGE = 'https://picsum.photos/id/237/400/300.jpg';

/** A stored video on the dev resource host: 1280×720, 5.038 s. */
const VIDEO = 'https://resource-dev.breatic.cc/video/2026-10-08/1791458288343_3baa41ff-9f1b-4f24-b997-28d1c0520055.mp4';

let page: Page;
let projectId = '';
let spaceId = '';
let imageNode = '';

/**
 * Seed a node straight into the live canvas document.
 * @param id - Node id.
 * @param type - Node modality.
 * @param x - Flow x.
 * @param data - Extra data fields.
 * @returns Nothing; resolves once the document holds the node.
 */
async function seedNode(id: string, type: string, x: number, data: Record<string, unknown> = {}): Promise<void> {
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, nodeId, nodeType, at, raw, url]: [string, string, string, string, number, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        addNode: (p: string, s: string, n: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: nodeId,
        type: nodeType,
        position: { x: at, y: 0 },
        data: {
          name: 'SEED',
          createdAt: Date.now(),
          createdBy: 'mini-tools-e2e',
          locked: false,
          attachments: [],
          ...(JSON.parse(raw) as Record<string, unknown>),
        },
      });
    },
    [projectId, spaceId, id, type, x, JSON.stringify(data), canvasAt] as [
      string,
      string,
      string,
      string,
      number,
      string,
      string,
    ],
  );
  await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`)).toBeVisible({ timeout: 15_000 });
}

/**
 * Open a tool on a node from its menu.
 * @param nodeId - The node.
 * @param toolId - The tool.
 */
async function openTool(nodeId: string, toolId: string): Promise<void> {
  await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).click({ button: 'right' });
  await page.getByTestId('node-menu-tools').hover();
  await page.getByTestId(`node-menu-tool-${toolId}`).click();
}

/**
 * Drag across a crop box from one fraction of it to another.
 * @param layer - The box's capture layer.
 * @param from - Start, as fractions of the box.
 * @param to - End, as fractions of the box.
 */
async function dragAcross(layer: Locator, from: [number, number], to: [number, number]): Promise<void> {
  const box = await layer.boundingBox();
  if (box === null) throw new Error('the crop box has no box');
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/**
 * Drag a handle to a fraction of the crop box.
 * @param handle - The handle.
 * @param layer - The box's capture layer.
 * @param to - Where to, as fractions of the box.
 */
async function dragHandle(handle: Locator, layer: Locator, to: [number, number]): Promise<void> {
  const grip = await handle.boundingBox();
  const box = await layer.boundingBox();
  if (grip === null || box === null) throw new Error('no handle or box');
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/**
 * Zoom the canvas with the wheel over its middle.
 * @param deltaY - Wheel delta; negative zooms in.
 */
async function zoomBy(deltaY: number): Promise<void> {
  const pane = visibleSpace(page).locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('no pane');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `mini-tools-e2e-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  imageNode = randomUUID();
  await seedNode(imageNode, 'image', 0, { content: IMAGE, mimeType: 'image/jpeg', size: 40_000 });
  await expect(
    visibleSpace(page).locator(`.react-flow__node[data-id="${imageNode}"] [data-testid=image-node-img]`),
  ).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

test('the crop box sits on the picture inside the node and its handles hold 8px at any zoom @needs-internet', async () => {
  await openTool(imageNode, 'image.crop');
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${imageNode}"]`);
  const layer = node.getByTestId('mini-tool-crop-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });

  // The box covers the picture, to the pixel.
  const picture = await node.getByTestId('image-node-img').boundingBox();
  const covered = await layer.boundingBox();
  expect(picture).not.toBeNull();
  expect(covered).not.toBeNull();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(covered![key] - picture![key])).toBeLessThan(1);
  }

  const handle = node.getByTestId('mini-tool-crop-handle-se');
  for (const deltaY of [0, 600, 600, -1500]) {
    if (deltaY !== 0) await zoomBy(deltaY);
    await expect
      .poll(async () => Math.round((await handle.boundingBox())?.width ?? 0), { timeout: 5_000 })
      .toBe(8);
    // The box still covers the picture after the zoom.
    const shown = await node.getByTestId('image-node-img').boundingBox();
    const over = await layer.boundingBox();
    expect(Math.abs(over!.x - shown!.x)).toBeLessThan(1);
    expect(Math.abs(over!.width - shown!.width)).toBeLessThan(1);
  }
});

test('a drawn crop sets the size in the panel, and Run fills a new node downstream @needs-internet', async () => {
  await openTool(imageNode, 'image.crop');
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${imageNode}"]`);
  const layer = node.getByTestId('mini-tool-crop-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  // The box starts on the whole picture (400×300 in its own pixels); pulling
  // the two corners in to a quarter and three quarters leaves 200×150.
  await dragHandle(node.getByTestId('mini-tool-crop-handle-nw'), layer, [0.25, 0.25]);
  await dragHandle(node.getByTestId('mini-tool-crop-handle-se'), layer, [0.75, 0.75]);
  // The pointer lands on whole screen pixels, so a side may be off by one.
  await expect.poll(async () => Number(await page.getByTestId('mini-tool-rect-w').inputValue())).toBeGreaterThanOrEqual(199);
  expect(Number(await page.getByTestId('mini-tool-rect-w').inputValue())).toBeLessThanOrEqual(201);
  expect(Math.abs(Number(await page.getByTestId('mini-tool-rect-h').inputValue()) - 150)).toBeLessThanOrEqual(1);

  await page.getByTestId('mini-tool-run').click();
  const made = visibleSpace(page).locator(`.react-flow__node:not([data-id="${imageNode}"])`);
  await expect(made).toHaveCount(1, { timeout: 15_000 });
  await expect(made).toContainText('CROP-SEED');
  await expect(made.getByTestId('image-node-img')).toHaveAttribute('src', /^https?:\/\//, { timeout: 60_000 });
});

// The upscale panel offers output sizes with the pixel size each comes to on
// the picture, 4K picked, and the creativity slider names its two ends.
test('the upscale panel offers sizes measured on the picture @needs-internet', async () => {
  await openTool(imageNode, 'image.upscale');
  const fourK = page.getByTestId('mini-tool-size-target_megapixels-4K');
  await expect(fourK).toHaveAttribute('aria-current', 'true');
  await expect(fourK).toHaveText(/4K\s*≈(\d+×4096|4096×\d+)/);
  await expect(page.getByTestId('generate-param-creativity-stop--10')).toHaveText('Closer to source');
  await expect(page.getByTestId('generate-param-creativity-stop-10')).toHaveText('More detail');
  const eightK = (await page.getByTestId('mini-tool-size-target_megapixels-8K').boundingBox())!;
  const close = (await page.getByTestId('mini-tool-panel-close').boundingBox())!;
  expect(eightK.x + eightK.width).toBeLessThanOrEqual(close.x + close.width + 0.5);
  // The footer puts the cost at the left edge, under the title, and Run at the right, under the close button.
  const title = (await page.getByTestId('mini-tool-panel-title').boundingBox())!;
  const credit = (await page.getByTestId('mini-tool-credit').boundingBox())!;
  const run = (await page.getByTestId('mini-tool-run').boundingBox())!;
  expect(Math.abs(credit.x - title.x)).toBeLessThan(1);
  expect(Math.abs(run.x + run.width - (close.x + close.width))).toBeLessThan(1);
  await page.keyboard.press('Escape');
});

test('Run on the rotate tool fills a new node downstream @needs-internet', async () => {
  await openTool(imageNode, 'image.rotate');
  // The four buttons share the panel's width: the last one ends no further
  // right than the close button, which sits inside the panel's right padding.
  const last = (await page.getByTestId('mini-tool-orient-flipY').boundingBox())!;
  const close = (await page.getByTestId('mini-tool-panel-close').boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(close.x + close.width + 0.5);
  await page.getByTestId('mini-tool-orient-right').click();
  await page.getByTestId('mini-tool-run').click();
  const made = visibleSpace(page).locator(`.react-flow__node:not([data-id="${imageNode}"])`);
  await expect(made).toHaveCount(1, { timeout: 15_000 });
  await expect(made.getByTestId('image-node-img')).toHaveAttribute('src', /^https?:\/\//, { timeout: 60_000 });
});

test('the focus crop draws inside the picked node and its bar hangs under it @needs-internet', async () => {
  const host = randomUUID();
  await seedNode(host, 'image', 600);
  await visibleSpace(page).locator(`.react-flow__node[data-id="${host}"]`).click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
  await page.getByTestId('generate-tool-focus').click();
  await visibleSpace(page).locator(`.react-flow__node[data-id="${imageNode}"]`).click();

  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${imageNode}"]`);
  const layer = node.getByTestId('focus-crop-layer');
  await expect(layer).toBeVisible({ timeout: 15_000 });
  const bar = page.getByTestId('focus-crop-controls');
  await expect(bar).toBeVisible();
  // Under the node it belongs to.
  const nodeBox = await node.boundingBox();
  const barBox = await bar.boundingBox();
  expect(barBox!.y).toBeGreaterThan(nodeBox!.y + nodeBox!.height - 1);

  await dragAcross(layer, [0.2, 0.2], [0.6, 0.7]);
  await expect(node.getByTestId('focus-crop-rect')).toBeVisible();
  // Handles round while free.
  await expect(node.getByTestId('focus-crop-handle-se')).toHaveClass(/rounded-full/);
  await page.getByTestId('focus-ratio-1:1').click();
  await expect(node.getByTestId('focus-crop-handle-se')).not.toHaveClass(/rounded-full/);

  // The marquee is held in the picture's own pixels: a zoom keeps it on the same part of it.
  const before = await node.getByTestId('focus-crop-rect').boundingBox();
  const pictureBefore = await node.getByTestId('image-node-img').boundingBox();
  await zoomBy(-400);
  const after = await node.getByTestId('focus-crop-rect').boundingBox();
  const pictureAfter = await node.getByTestId('image-node-img').boundingBox();
  const fraction = (r: { x: number }, p: { x: number; width: number }): number => (r.x - p.x) / p.width;
  expect(fraction(after!, pictureAfter!)).toBeCloseTo(fraction(before!, pictureBefore!), 2);

  await page.getByTestId('focus-crop-confirm').click();
  await expect(bar).toHaveCount(0, { timeout: 5_000 });
});

// §7.2: the panel and its draft belong to the Space, so leaving and coming back
// finds them as they were.
test('the tool panel and its draft wait in their Space while another is open @needs-internet', async () => {
  await openTool(imageNode, 'image.crop');
  await page.getByTestId('mini-tool-param-aspect-1:1').click();
  await expect(page.getByTestId('mini-tool-param-aspect-1:1')).toHaveAttribute('aria-current', 'true');

  const other = await createSpace(page, 'canvas', `mini-tools-other-${Date.now()}`);
  try {
    // The Space left behind stays mounted, hidden, so its panel is out of sight.
    await expect(page.getByTestId('mini-tool-panel-title')).toBeHidden();
    await page.getByTestId(`space-tab-${spaceId}`).click();
    await expect(page.getByTestId('mini-tool-panel-title')).toBeVisible();
    await expect(page.getByTestId('mini-tool-param-aspect-1:1')).toHaveAttribute('aria-current', 'true');
  } finally {
    await deleteSpace(page, other);
  }
});

// §7.2: what was measured on the old picture is reset when the source takes
// new content, so the crop covers the new picture whole.
test('a source that takes new content resets the crop to the new picture @needs-internet', async () => {
  await openTool(imageNode, 'image.crop');
  await page.getByTestId('mini-tool-param-aspect-1:1').click();
  await expect.poll(async () => page.getByTestId('mini-tool-rect-w').inputValue()).toBe('300');

  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, nodeId, url, managerUrl, canvasUrl]: string[]) => {
      const manager = (await import(/* @vite-ignore */ managerUrl!)) as {
        getDoc: (name: string) => unknown;
        docName: { canvasSpace: (p: string, s: string) => string };
      };
      const canvas = (await import(/* @vite-ignore */ canvasUrl!)) as {
        nodeDataMap: (doc: unknown, id: string) => { set: (k: string, v: unknown) => void } | null;
      };
      const doc = manager.getDoc(manager.docName.canvasSpace(pid!, sid!));
      canvas.nodeDataMap(doc, nodeId!)!.set('content', url!);
    },
    [projectId, spaceId, imageNode, 'https://picsum.photos/id/238/600/300.jpg', managerAt, canvasAt],
  );

  await expect.poll(async () => page.getByTestId('mini-tool-rect-w').inputValue(), { timeout: 20_000 }).toBe('600');
  expect(await page.getByTestId('mini-tool-rect-h').inputValue()).toBe('300');
});

// A pasted video holds the media fields of its source, so the cut panel can
// lay out its frames on the copy too (inner#888).
test('the cut panel shows the frames of a pasted video @needs-internet', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const source = randomUUID();
  await seedNode(source, 'video', 600, {
    content: VIDEO,
    mediaWidth: 1280,
    mediaHeight: 720,
    duration: 5.038,
    mimeType: 'video/mp4',
    size: 5_469_707,
  });
  const nodes = visibleSpace(page).locator('.react-flow__node');
  const before = await nodes.count();
  await visibleSpace(page).locator(`.react-flow__node[data-id="${source}"]`).click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(nodes).toHaveCount(before + 1);

  const copy = visibleSpace(page).locator('.react-flow__node').filter({ hasText: 'COPY-SEED' });
  const copyId = await copy.getAttribute('data-id');
  expect(copyId).not.toBeNull();
  await openTool(copyId!, 'video.cut');
  await expect(page.getByTestId('mini-tool-filmstrip')).toBeVisible({ timeout: 15_000 });
});
