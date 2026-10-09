// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasted and duplicated copies come out selected, on screen and focused, so
 * the arrow keys move them through xyflow's own handler (inner#1349 A12).
 * Text nodes only, so it needs no storage.
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1500, height: 900 } });
let page: Page;
let projectId = '';
let spaceId = '';
let textId = '';

/** A node as the document holds it. */
interface DocNode {
  id: string;
  position: { x: number; y: number };
}

/**
 * Runs code against the canvas module the page already loaded.
 * @param source - A function body given `canvas`, `pid`, `sid` and `extra`.
 * @param extra - One value handed to the body.
 * @returns What the body returns.
 */
async function onCanvas<T>(source: string, extra: unknown = null): Promise<T> {
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([at, pid, sid, body, arg]: [string, string, string, string, unknown]) => {
      const canvas = await import(/* @vite-ignore */ at);
      const run = new Function('canvas', 'pid', 'sid', 'extra', body) as (
        c: unknown,
        p: string,
        s: string,
        e: unknown,
      ) => unknown;
      return run(canvas, pid, sid, arg) as unknown;
    },
    [url, projectId, spaceId, source, extra] as [string, string, string, string, unknown],
  ) as Promise<T>;
}

/** Every node in the document. */
async function nodes(): Promise<DocNode[]> {
  return onCanvas('return canvas.readCanvasGraph(pid, sid).nodes.map((n) => ({ id: n.id, position: n.position }));');
}

/**
 * A node's element on the canvas.
 * @param id - The node.
 * @returns Its locator.
 */
const drawn = (id: string): ReturnType<Page['locator']> => visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);

/** The id of the node that holds the keyboard, or null. */
async function focusedNode(): Promise<string | null> {
  return page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? null,
  );
}

/**
 * Whether a node lies wholly inside the canvas pane on screen.
 * @param id - The node.
 * @returns True when every edge is inside the pane.
 */
async function wholeOnScreen(id: string): Promise<boolean> {
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  const box = await drawn(id).boundingBox();
  if (pane === null || box === null) return false;
  return box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
}

/**
 * Waits for exactly one new node and checks it is selected, wholly on screen
 * and focused.
 * @param before - The nodes before the paste or duplicate.
 * @returns The new node as it first landed.
 */
async function readyCopy(before: DocNode[]): Promise<DocNode> {
  await expect.poll(async () => (await nodes()).length, { timeout: 20_000 }).toBe(before.length + 1);
  const [copy] = (await nodes()).filter((n) => !before.some((b) => b.id === n.id));
  if (copy === undefined) throw new Error('no new node');
  await expect(drawn(copy.id)).toHaveClass(/selected/);
  await expect.poll(() => wholeOnScreen(copy.id)).toBe(true);
  await expect.poll(focusedNode).toBe(copy.id);
  return copy;
}

/**
 * Where a node sits across the canvas now.
 * @param id - The node.
 * @returns Its x, or undefined when it is gone.
 */
async function xOf(id: string): Promise<number | undefined> {
  return (await nodes()).find((n) => n.id === id)?.position.x;
}

/** Click the seeded text node on its top edge, where no control sits. */
async function clickText(): Promise<void> {
  const box = await drawn(textId).boundingBox();
  await page.mouse.click((box?.x ?? 0) + Math.min(20, (box?.width ?? 0) / 2), (box?.y ?? 0) + 6);
}

test.beforeEach(async ({ page: opened, context }) => {
  test.setTimeout(120_000);
  page = opened;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] as string;
  spaceId = await createSpace(page, 'canvas', `paste-focus-e2e-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  textId = `paste-focus-text-${Date.now()}`;
  await onCanvas(
    `canvas.addNode(pid, sid, { id: extra, type: 'text', position: { x: 0, y: 0 },
       data: { createdAt: Date.now(), createdBy: 'paste-focus-e2e', locked: false, attachments: [], name: 'Brief', content: 'hello' } });`,
    textId,
  );
  await expect(drawn(textId)).toBeVisible();
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  spaceId = '';
});

test('a keyboard paste comes out selected and focused', async () => {
  const before = await nodes();
  await clickText();
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ControlOrMeta+V');
  const copy = await readyCopy(before);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => xOf(copy.id)).toBeGreaterThan(copy.position.x);
});

test('a keyboard duplicate comes out selected and focused', async () => {
  const before = await nodes();
  await clickText();
  await page.keyboard.press('ControlOrMeta+D');
  const copy = await readyCopy(before);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => xOf(copy.id)).toBeGreaterThan(copy.position.x);
});

test('a duplicate from the node menu comes out focused once the menu closes', async () => {
  const before = await nodes();
  const box = await drawn(textId).boundingBox();
  await page.mouse.click((box?.x ?? 0) + 20, (box?.y ?? 0) + 6, { button: 'right' });
  await page.getByTestId('node-menu-duplicate').click();
  const copy = await readyCopy(before);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => xOf(copy.id)).toBeGreaterThan(copy.position.x);
});

test('a paste from the canvas menu comes out focused once the menu closes', async () => {
  const before = await nodes();
  await clickText();
  await page.keyboard.press('ControlOrMeta+C');
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  await page.mouse.click((pane?.x ?? 0) + 200, (pane?.y ?? 0) + (pane?.height ?? 600) - 150, { button: 'right' });
  await page.getByTestId('canvas-menu-paste').click();
  const copy = await readyCopy(before);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => xOf(copy.id)).toBeGreaterThan(copy.position.x);
});

test('a picture pasted with the keyboard comes out selected and focused', async () => {
  const before = await nodes();
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(32, 24);
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
      ctx.fillStyle = 'rgb(30, 90, 200)';
      ctx.fillRect(0, 0, 32, 24);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  await page.mouse.click((pane?.x ?? 0) + 200, (pane?.y ?? 0) + (pane?.height ?? 600) - 150);
  await page.keyboard.press('ControlOrMeta+V');
  const copy = await readyCopy(before);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => xOf(copy.id)).toBeGreaterThan(copy.position.x);
});

test('a duplicate that lands out of view brings the view to it', async () => {
  // Only a sliver of the node shows at the pane's right edge, so its copy lands outside the view.
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  const at = await drawn(textId).boundingBox();
  const shift = (pane?.x ?? 0) + (pane?.width ?? 0) - 10 - (at?.x ?? 0);
  await onCanvas('canvas.setNodePosition(pid, sid, extra.id, { x: extra.shift, y: 0 }, null);', { id: textId, shift });
  await expect.poll(async () => (await drawn(textId).boundingBox())?.x ?? 0).toBeGreaterThan((pane?.x ?? 0) + (pane?.width ?? 0) - 20);
  const before = await nodes();
  const sliver = await drawn(textId).boundingBox();
  await page.mouse.click((sliver?.x ?? 0) + 4, (sliver?.y ?? 0) + 6);
  await expect(drawn(textId)).toHaveClass(/selected/);
  await page.keyboard.press('ControlOrMeta+D');
  const copy = await readyCopy(before);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => xOf(copy.id)).toBeGreaterThan(copy.position.x);
});
