// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The camera-angle sphere on Qwen Image Multiple Angles (inner#830): it loads
 * only when the settings open, puts the picture the model is sent on its
 * card, sets the pose by dragging, the wheel and the keyboard, writes the
 * node once per gesture on the grid the upstream rounds to, and the submit
 * carries it.
 *
 * The submit is stubbed: which side the model turns to was measured on real
 * runs when the control was designed, and is not what this checks.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, YJS_MANAGER, liveModuleUrl } from '../helpers/live-module';
import { createSpace, deleteSpace } from '../helpers/space';

test.use({ viewport: { width: 1900, height: 1300 } });
test.setTimeout(90_000);

const QWEN = 'qwen-image-edit-multiple-angles';
const PORTRAIT = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=768&q=80';

let page: Page;
let projectId = '';
let spaceId = '';

/**
 * Write an image node into the open Space at a point of the window.
 * @param p - A page with the Space open.
 * @param x - Window x of its top-left corner.
 * @param y - Window y of its top-left corner.
 * @param content - Its picture, if it has one.
 * @returns The node's id.
 */
async function seedImageNode(p: Page, x: number, y: number, content?: string): Promise<string> {
  await expect(p.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = crypto.randomUUID();
  const at = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, id, left, top, url, asset]: [string, string, string, number, number, string, string]) => {
      const vp = document.querySelector('.react-flow__viewport');
      if (!(vp instanceof HTMLElement)) throw new Error('canvas not mounted');
      const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
      const canvas = (await import(/* @vite-ignore */ url)) as { addNode: (p: string, s: string, n: unknown) => void };
      canvas.addNode(pid, sid, {
        id,
        type: 'image',
        position: { x: (left - m.e) / m.a, y: (top - m.f) / m.d },
        data: {
          name: 'angle-e2e',
          createdAt: Date.now(),
          createdBy: 'angle-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
          ...(asset ? { content: asset, status: 'ready' } : {}),
        },
      });
    },
    [projectId, spaceId, nodeId, x, y, at, content ?? ''] as [string, string, string, number, number, string, string],
  );
  return nodeId;
}

/**
 * The three camera params the node holds for the Qwen model.
 * @param p - A page with the Space open.
 * @param nodeId - The node.
 * @returns What it holds.
 */
async function storedPose(p: Page, nodeId: string): Promise<Record<string, unknown>> {
  const at = await liveModuleUrl(p, CANVAS_SPACE);
  return p.evaluate(
    async ([pid, sid, id, url, model]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data: Record<string, unknown> }[] };
      };
      const node = canvas.readCanvasGraph(pid, sid).nodes.find((n) => n.id === id);
      const all = (node?.data.paramsByModel ?? {}) as Record<string, Record<string, unknown>>;
      const own = all[model] ?? {};
      return { horizontal_angle: own.horizontal_angle, vertical_angle: own.vertical_angle, distance: own.distance };
    },
    [projectId, spaceId, nodeId, at, QWEN] as [string, string, string, string, string],
  );
}

/**
 * Count the transactions that change the node's params from now on, so a
 * gesture can be held to one write.
 * @param p - A page with the Space open.
 * @param nodeId - The node.
 * @returns Reads the count so far.
 */
async function countParamWrites(p: Page, nodeId: string): Promise<() => Promise<number>> {
  const at = await liveModuleUrl(p, YJS_MANAGER);
  await p.evaluate(
    async ([pid, sid, id, url]: [string, string, string, string]) => {
      const manager = (await import(/* @vite-ignore */ url)) as {
        getDoc: (name: string) => { getMap: (k: string) => { observeDeep: (f: (events: { path: unknown[]; keysChanged?: Set<string> }[]) => void) => void } };
        docName: { canvasSpace: (p: string, s: string) => string };
      };
      const w = window as unknown as { __paramWrites: number };
      w.__paramWrites = 0;
      manager.getDoc(manager.docName.canvasSpace(pid, sid)).getMap('nodesMap').observeDeep((events) => {
        const touched = events.some(
          (e) => e.path.includes(id) && (e.path.includes('paramsByModel') || e.keysChanged?.has('paramsByModel') === true),
        );
        if (touched) w.__paramWrites += 1;
      });
    },
    [projectId, spaceId, nodeId, at] as [string, string, string, string],
  );
  return () => p.evaluate(() => (window as unknown as { __paramWrites: number }).__paramWrites);
}

/**
 * Seed a portrait and a target wired to it, open the target's panel on Qwen
 * with the portrait mentioned, and open the settings popover.
 * @param p - A page with the Space open.
 * @returns The target node's id and every request made once the popover opened.
 */
async function openOnQwen(p: Page): Promise<{ target: string; requested: string[] }> {
  const source = await seedImageNode(p, 450, 150, PORTRAIT);
  const target = await seedImageNode(p, 900, 150);
  const at = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, from, to, url]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as { addEdge: (p: string, s: string, e: unknown) => boolean };
      if (!canvas.addEdge(pid, sid, { id: `${from}->${to}`, source: from, target: to })) throw new Error('edge refused');
    },
    [projectId, spaceId, source, target, at] as [string, string, string, string, string],
  );
  const node = p.locator(`.react-flow__node[data-id="${target}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await p.getByTestId('node-menu-generate').click();
  await expect(p.getByTestId('generate-execute')).toBeVisible({ timeout: 15_000 });
  await p.getByTestId('generate-mode-trigger').click();
  await p.getByTestId('generate-mode-i2i').click();
  await p.getByTestId('generate-model-trigger').click();
  await p.getByTestId(`generate-model-option-${QWEN}`).click();
  await p.getByTestId('generate-prompt-editor').click();
  await p.keyboard.type('@');
  await p.keyboard.press('Enter');
  await p.keyboard.type(' keep the same person.');
  const requested: string[] = [];
  p.on('request', (r) => requested.push(r.url()));
  await p.getByTestId('generate-ratio-trigger').click();
  await expect(p.getByTestId('generate-camera-angle-sphere')).toBeVisible({ timeout: 15_000 });
  return { target, requested };
}

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ storageState: STATE_FILE.A });
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `angle-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  await page.keyboard.press('Escape');
  if (spaceId) await deleteSpace(page, spaceId);
  await page.close();
});

test('loads the sphere when the settings open, with the mentioned picture on its card @needs-internet', async () => {
  const before: string[] = [];
  page.on('request', (r) => before.push(r.url()));
  const { requested } = await openOnQwen(page);
  // three.js comes in its own chunk, fetched once the popover asks for it.
  expect(before.filter((u) => /CameraAngleSphere/.test(u) && !requested.includes(u))).toEqual([]);
  expect(requested.some((u) => /CameraAngleSphere/.test(u))).toBe(true);
  // The card fetches the portrait fresh in CORS mode; a tainted fetch would fail the texture.
  await expect.poll(() => requested.some((u) => u.startsWith(PORTRAIT.split('?')[0]!) && u.includes('cors=1'))).toBe(true);
  await expect(page.getByTestId('generate-camera-angle-sphere')).toHaveAttribute('data-card', 'picture', { timeout: 30_000 });
  await expect(page.getByTestId('generate-camera-angle-pose')).toHaveText('Front · Eye level · Medium shot');
  await expect(page.getByTestId('generate-ratio-trigger')).toContainText('Front · Eye level · Medium shot');
});

test('drags the camera, moves the sliders with it, and writes one pose on the grid on release @needs-internet', async () => {
  const { target } = await openOnQwen(page);
  const writes = await countParamWrites(page, target);
  const sphere = page.getByTestId('generate-camera-angle-sphere');
  const box = await sphere.boundingBox();
  if (!box) throw new Error('sphere not drawn');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.55, { steps: 12 });
  const midDrag = await page.getByTestId('generate-param-horizontal_angle-value').textContent();
  const stillStored = await storedPose(page, target);
  await page.mouse.up();
  await expect.poll(() => storedPose(page, target)).not.toEqual(stillStored);
  const after = await storedPose(page, target);
  expect([0, 45, 90, 135, 180, 225, 270, 315]).toContain(after.horizontal_angle);
  expect([-30, 0, 30, 60]).toContain(after.vertical_angle);
  expect(after.distance).toBe(1);
  expect(midDrag?.startsWith(`${String(after.horizontal_angle)}° `)).toBe(true);
  expect(await writes()).toBe(1);
});

test('moves one distance step per wheel gesture and steps the pose by key, then resets @needs-internet', async () => {
  const { target } = await openOnQwen(page);
  const sphere = page.getByTestId('generate-camera-angle-sphere');
  // From the close-up there are two steps to go, so a gesture that took more than one would show.
  await page.getByTestId('generate-param-distance-stop-0').click();
  await expect.poll(() => storedPose(page, target)).toEqual({ horizontal_angle: 0, vertical_angle: 0, distance: 0 });
  const writes = await countParamWrites(page, target);
  // Twenty events in one burst: `page.mouse.wheel` waits for each to be handled, and a pause past
  // the 150ms settle between two of them is, by the rule under test, a second gesture.
  await sphere.evaluate((el) => {
    for (let i = 0; i < 20; i += 1) el.dispatchEvent(new WheelEvent('wheel', { deltaY: 8, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => storedPose(page, target)).toEqual({ horizontal_angle: 0, vertical_angle: 0, distance: 1 });
  await page.waitForTimeout(300);
  expect(await storedPose(page, target)).toEqual({ horizontal_angle: 0, vertical_angle: 0, distance: 1 });
  expect(await writes()).toBe(1);

  await page.getByTestId('generate-camera-angle').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => storedPose(page, target)).toEqual({ horizontal_angle: 45, vertical_angle: 0, distance: 1 });
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => storedPose(page, target)).toEqual({ horizontal_angle: 45, vertical_angle: 30, distance: 1 });
  await expect(page.getByTestId('generate-camera-angle-pose')).toHaveText('Front right · Elevated · Medium shot');

  await page.getByTestId('generate-camera-angle-reset').click();
  await expect.poll(() => storedPose(page, target)).toEqual({ horizontal_angle: 0, vertical_angle: 0, distance: 1 });
});

test('lays every slider name out apart and inside the popover, in every interface language @needs-internet', async () => {
  await openOnQwen(page);
  await page.keyboard.press('Escape');
  try {
    for (const lang of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      await page.getByTestId('lang-trigger').click();
      await page.getByTestId(`lang-option-${lang}`).click();
      await expect(page.getByTestId('lang-popover')).toHaveCount(0);
      await page.getByTestId('generate-ratio-trigger').click();
      await expect(page.getByTestId('generate-camera-angle')).toBeVisible();
      // Values read in English whatever the interface language.
      await expect(page.getByTestId('generate-camera-angle-pose')).toHaveText('Front · Eye level · Medium shot');
      const layout = await page.evaluate(() => {
        const box = (el: Element): DOMRect => el.getBoundingClientRect();
        const pose = document.querySelector('[data-testid="generate-camera-angle-pose"]');
        const card = document.querySelector('[data-testid="generate-camera-angle"]');
        const frame = card?.closest('[data-radix-popper-content-wrapper] > *');
        const rows = ['horizontal_angle', 'vertical_angle', 'distance'].map((name) =>
          [...document.querySelectorAll(`[data-testid^="generate-param-${name}-stop-"]`)].map((el) => ({
            name: el.textContent ?? '',
            ...box(el).toJSON(),
          })),
        );
        const outer = frame ? box(frame) : null;
        return {
          poseCut: pose ? pose.scrollWidth > pose.clientWidth : true,
          overlaps: rows.flatMap((stops) =>
            stops.slice(1).flatMap((s, i) => (s.left < stops[i]!.right ? [`${stops[i]!.name} | ${s.name}`] : [])),
          ),
          outside: outer ? rows.flat().filter((s) => s.left < outer.left || s.right > outer.right).map((s) => s.name) : ['no popover'],
        };
      });
      expect({ lang, ...layout }).toEqual({ lang, poseCut: false, overlaps: [], outside: [] });
      await page.keyboard.press('Escape');
    }
  } finally {
    await page.getByTestId('lang-trigger').click();
    await page.getByTestId('lang-option-en').click();
  }
});

test('stands the camera on the subject\'s own right at 90° and on its left at 270° @needs-internet', async () => {
  const { target } = await openOnQwen(page);
  const sphere = page.getByTestId('generate-camera-angle-sphere');
  await page.getByTestId('generate-param-horizontal_angle-stop-90').click();
  await expect.poll(() => storedPose(page, target)).toMatchObject({ horizontal_angle: 90 });
  // The card faces +z, so the subject's own right is -x.
  await expect.poll(async () => Number(await sphere.getAttribute('data-camera-x'))).toBeLessThan(0);
  await page.getByTestId('generate-param-horizontal_angle-stop-270').click();
  await expect.poll(() => storedPose(page, target)).toMatchObject({ horizontal_angle: 270 });
  await expect.poll(async () => Number(await sphere.getAttribute('data-camera-x'))).toBeGreaterThan(0);
});

test('sends the pose the node holds @needs-internet', async () => {
  const { target } = await openOnQwen(page);
  await page.getByTestId('generate-param-horizontal_angle-stop-270').click();
  await expect.poll(() => storedPose(page, target)).toMatchObject({ horizontal_angle: 270 });
  await page.keyboard.press('Escape');
  let body: Record<string, unknown> | undefined;
  await page.route('**/canvas/tasks', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });
  await page.getByTestId('generate-execute').click();
  await expect.poll(() => body).toBeDefined();
  expect((body?.params ?? {}) as Record<string, unknown>).toMatchObject({
    horizontal_angle: 270,
    vertical_angle: 0,
    distance: 1,
  });
});
