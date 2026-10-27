// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One component's native pointer behaviour, Activity lifetime and themed pixels.
 * Objects are placed through the real scene UI. All gizmo targeting comes from
 * the rendered official controls; no synthetic pointer or model payload is used.
 */
import { expect, type Locator, type Page } from 'playwright/test';
import { writeFile } from 'node:fs/promises';
import { Matrix4, Vector3 } from 'three';
import { test } from '../helpers/slot';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

type Tuple3 = [number, number, number];
interface RenderedObject {
  id: string;
  position: Tuple3;
  rotation: [number, number, number, number];
  scale: Tuple3;
}
interface HandleObservation {
  name: string;
  visible: boolean;
  layer: number;
  cameraLayer: boolean;
  rayLayer: boolean;
  center: Tuple3;
}
interface NativeObservation {
  mode: 'translate' | 'rotate' | 'scale';
  axis: string | null;
  dragging: boolean;
  enabled: boolean;
  center: Tuple3 | null;
  worldCenter: Tuple3 | null;
  scaleVisible: boolean;
  scaleHandles: HandleObservation[];
  scalePickers: HandleObservation[];
  projectionMatrix: number[];
  matrixWorldInverse: number[];
  background: string;
  render: { calls: number; triangles: number; geometries: number; textures: number; programs: number; contextLost: boolean; renderer: string; version: string };
}
interface PersonalView {
  position: Tuple3;
  target: Tuple3;
}

let pageErrors: string[] = [];
let consoleErrors: string[] = [];

test.use({ viewport: { width: 1440, height: 960 } });
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  consoleErrors = [];
  page.on('pageerror', (error) => { pageErrors.push(error.message); });
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
});
test.afterEach(async () => {
  await test.info().attach('browser-errors', { body: JSON.stringify({ pageErrors, consoleErrors }, null, 2), contentType: 'application/json' });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

/**
 * Limit every scene query to the Space currently shown by Activity.
 * @param page - The signed-in page displaying a Project.
 * @returns The visible scene's real WebGL canvas.
 * @throws {never} Never directly.
 */
function viewport(page: Page): Locator {
  return visibleSpace(page).getByTestId('three-d-viewport');
}

/**
 * Read field tuples directly from the attached model instances.
 * @param page - The page whose current scene is under test.
 * @returns The renderer's current complete object transforms.
 * @throws {Error} When the displayed renderer has not published its tuples.
 */
async function rendered(page: Page): Promise<RenderedObject[]> {
  const raw = await viewport(page).getAttribute('data-objects');
  if (raw === null) throw new Error('The visible renderer has no object observation');
  return JSON.parse(raw) as RenderedObject[];
}

/**
 * Read the official controls only after a real Three render has observed them.
 * @param page - The page with a visible development renderer.
 * @returns Native helper transforms, visibility and actual GPU drawing statistics.
 * @throws {Error} When the development observation is missing.
 */
async function native(page: Page): Promise<NativeObservation> {
  const raw = await viewport(page).getAttribute('data-native-controls');
  if (raw === null) throw new Error('The visible renderer has no development native-control observation');
  return JSON.parse(raw) as NativeObservation;
}

/**
 * Give Three and theme observers two actual animation frames to settle.
 * @param page - The page whose visible canvas should render again.
 * @throws {Error} When the visible viewport is unavailable.
 */
async function renderedFrames(page: Page): Promise<void> {
  await viewport(page).evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/**
 * Create the case's own scene and place one built-in through its actual UI.
 * @param page - The slot's authenticated browser page.
 * @param name - A unique name for the Space being created.
 * @returns The created Space ID; the caller must remove it in finally.
 * @throws {Error} When scene creation or native rendering fails.
 */
async function openScene(page: Page, name: string): Promise<string> {
  await openSmokeProject(page);
  return createSpace(page, '3d', name);
}

/**
 * Place an actual model without substituting a renderer fixture.
 * @param page - The page containing the fresh scene.
 * @param kind - The built-in action to execute.
 * @param count - The number of loaded instances expected after placement.
 * @returns The transforms of the real loaded model instances.
 * @throws {Error} When the model or GPU does not become ready.
 */
async function place(page: Page, kind: 'figure' | 'block', count: number): Promise<RenderedObject[]> {
  await visibleSpace(page).getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: kind === 'figure' ? 'Add figure' : 'Add block', exact: true }).click();
  await expect.poll(async () => (await rendered(page)).length).toBe(count);
  await expect(viewport(page)).toHaveAttribute('data-native-controls', /.+/);
  await expect.poll(async () => (await native(page)).enabled).toBe(true);
  await renderedFrames(page);
  return rendered(page);
}

/**
 * Map a projection read from real native geometry into current client pixels.
 * @param page - The page whose canvas defines the client rectangle.
 * @param projected - Native Three normalized device coordinates.
 * @returns A client-space pointer location inside the actual canvas hit target.
 * @throws {Error} When the geometry projects offscreen or the canvas is covered.
 */
async function pointerPoint(page: Page, projected: Tuple3): Promise<{ x: number; y: number }> {
  const canvas = viewport(page);
  const box = await canvas.boundingBox();
  if (!box || projected.some((value) => !Number.isFinite(value)) || Math.abs(projected[0]) >= 1 || Math.abs(projected[1]) >= 1 || Math.abs(projected[2]) >= 1) {
    throw new Error(`Native handle does not project inside the visible canvas: ${JSON.stringify({ box, projected })}`);
  }
  const point = { x: box.x + (projected[0] + 1) * box.width / 2, y: box.y + (1 - projected[1]) * box.height / 2 };
  expect(await canvas.evaluate((element, target) => document.elementFromPoint(target.x, target.y) === element, point)).toBe(true);
  return point;
}

/**
 * Press the observed native centre and require the official XYZ picker to accept it.
 * @param page - The page to drive with Playwright's actual mouse.
 * @returns The initial client coordinates, suitable for a relative drag.
 * @throws {Error} When the native centre cannot be hit reproducibly.
 */
async function beginCentreDrag(page: Page): Promise<{ x: number; y: number }> {
  const observed = await native(page);
  if (!observed.center) throw new Error('The official controls have no attached native centre');
  const point = await pointerPoint(page, observed.center);
  await page.mouse.move(point.x, point.y);
  await expect.poll(async () => (await native(page)).axis, { message: 'The observed centre did not hit the native XYZ picker' }).toBe('XYZ');
  await page.mouse.down();
  await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'true');
  await expect.poll(async () => (await native(page)).dragging).toBe(true);
  return point;
}

/**
 * Attach actual native state and GPU evidence without adding a screenshot baseline.
 * @param page - The page with the component still visible.
 * @param name - The artifact label within this test result.
 * @throws {Error} When the viewport has no active WebGL drawing.
 */
async function attachEvidence(page: Page, name: string): Promise<void> {
  const observation = await native(page);
  expect(observation.render.contextLost).toBe(false);
  expect(observation.render.calls).toBeGreaterThan(0);
  expect(observation.render.triangles).toBeGreaterThan(0);
  expect(observation.render.programs).toBeGreaterThan(0);
  const screenshot = test.info().outputPath(`${name}-page.png`);
  await page.screenshot({ path: screenshot });
  await test.info().attach(`${name}-page`, { path: screenshot, contentType: 'image/png' });
  const evidence = test.info().outputPath(`${name}-native.json`);
  await writeFile(evidence, JSON.stringify({ observation, objects: await rendered(page) }, null, 2));
  await test.info().attach(`${name}-native`, { path: evidence, contentType: 'application/json' });
}

/**
 * Keep the last native frame even when a strict pointer assertion fails.
 * @param page - The page before its case-owned Space is removed.
 * @throws {Error} When the remaining canvas observation cannot be read.
 */
async function attachLastObservation(page: Page): Promise<void> {
  const canvas = viewport(page);
  if (await canvas.count() !== 1) return;
  await test.info().attach('native-before-cleanup', {
    body: JSON.stringify({ native: await canvas.getAttribute('data-native-controls'), objects: await canvas.getAttribute('data-objects'), gestureActive: await canvas.getAttribute('data-gesture-active') }, null, 2),
    contentType: 'application/json',
  });
}

/**
 * Wait for Orbit damping to stop changing the personal camera numerically.
 * @param page - The page whose actual camera has just navigated.
 * @returns The settled personal position and target read from the viewport.
 * @throws {Error} When navigation never reaches a stable view.
 */
async function settledView(page: Page): Promise<PersonalView> {
  return viewport(page).evaluate(async (canvas) => {
    let previous = JSON.parse(canvas.getAttribute('data-view') ?? 'null') as PersonalView | null;
    let stable = 0;
    for (let frame = 0; frame < 180; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = JSON.parse(canvas.getAttribute('data-view') ?? 'null') as PersonalView | null;
      const prior = previous ? [...previous.position, ...previous.target] : null;
      if (prior && current && [...current.position, ...current.target].every((value, index) => Math.abs(value - prior[index]) < 1e-7)) stable += 1;
      else stable = 0;
      if (stable >= 3 && current) return current;
      previous = current;
    }
    throw new Error('The real Orbit camera did not settle within 180 rendered frames');
  });
}

test('native move commits, Escape cancels its draft, and the next real drag still works', async ({ page }) => {
  const id = await openScene(page, `native-move-${Date.now()}`);
  try {
    const initial = (await place(page, 'figure', 1))[0];
    await visibleSpace(page).getByRole('button', { name: 'Move', exact: true }).click();
    const first = await beginCentreDrag(page);
    await page.mouse.move(first.x + 45, first.y - 30, { steps: 8 });
    await expect.poll(async () => (await rendered(page))[0].position).not.toEqual(initial.position);
    await page.mouse.up();
    await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'false');
    const committed = (await rendered(page))[0];
    expect(committed.rotation).toEqual(initial.rotation);
    expect(committed.scale).toEqual(initial.scale);

    const cancelled = await beginCentreDrag(page);
    await page.mouse.move(cancelled.x + 50, cancelled.y - 25, { steps: 8 });
    await expect.poll(async () => (await rendered(page))[0].position).not.toEqual(committed.position);
    await page.keyboard.press('Escape');
    await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'false');
    await page.mouse.up();
    await expect.poll(async () => (await rendered(page))[0].position).toEqual(committed.position);

    const next = await beginCentreDrag(page);
    await page.mouse.move(next.x + 35, next.y - 20, { steps: 8 });
    await page.mouse.up();
    await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'false');
    await expect.poll(async () => (await rendered(page))[0].position).not.toEqual(committed.position);
    expect((await rendered(page))[0].position.every(Number.isFinite)).toBe(true);
    await attachEvidence(page, 'move-cancel-next-drag');
  } finally {
    await attachLastObservation(page);
    await page.mouse.up();
    await deleteSpace(page, id);
  }
});

test('native centre scale stays positive and multiselect offers only uniform scaling', async ({ page }) => {
  const id = await openScene(page, `native-scale-${Date.now()}`);
  try {
    const single = (await place(page, 'figure', 1))[0];
    await visibleSpace(page).getByRole('button', { name: 'Scale', exact: true }).click();
    await expect.poll(async () => (await native(page)).mode).toBe('scale');
    const centre = await beginCentreDrag(page);
    await page.mouse.move(centre.x + 30, centre.y - 18, { steps: 8 });
    await page.mouse.up();
    await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'false');
    const scaled = (await rendered(page))[0];
    expect(scaled.scale[0]).toBeGreaterThan(single.scale[0]);
    for (let axis = 0; axis < 3; axis += 1) expect(scaled.scale[axis] / single.scale[axis]).toBeCloseTo(scaled.scale[0] / single.scale[0], 7);
    expect(scaled.position).toEqual(single.position);
    expect(scaled.rotation).toEqual(single.rotation);

    await place(page, 'block', 2);
    await visibleSpace(page).getByTestId('scene-objects-trigger').click();
    await page.getByTestId(`scene-object-${single.id}`).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('scene-properties-panel').getByText('Rotation (°): 0, 0, 0', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const observed = await native(page);
      return {
        mode: observed.mode,
        visible: [...new Set(observed.scaleHandles.filter((handle) => observed.scaleVisible && handle.visible && handle.cameraLayer).map((handle) => handle.name))],
        pickable: [...new Set(observed.scalePickers.filter((handle) => handle.visible && handle.rayLayer).map((handle) => handle.name))],
      };
    }).toEqual({ mode: 'scale', visible: ['XYZ'], pickable: ['XYZ'] });
    await visibleSpace(page).getByRole('button', { name: 'Focus selection', exact: true }).click();
    await settledView(page);
    const before = await rendered(page);
    const origin = (await native(page)).worldCenter;
    if (!origin) throw new Error('The multiselect native pivot has no world position');
    const multi = await beginCentreDrag(page);
    await page.mouse.move(multi.x + 28, multi.y - 16, { steps: 8 });
    await page.mouse.up();
    await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'false');
    const after = await rendered(page);
    const ratio = after[0].scale[0] / before[0].scale[0];
    expect(ratio).toBeGreaterThan(1);
    for (const original of before) {
      const copy = after.find((item) => item.id === original.id);
      if (!copy) throw new Error(`The native batch lost object ${original.id}`);
      for (let axis = 0; axis < 3; axis += 1) {
        expect(copy.scale[axis] / original.scale[axis]).toBeCloseTo(ratio, 7);
        expect(copy.position[axis]).toBeCloseTo(origin[axis] + (original.position[axis] - origin[axis]) * ratio, 7);
      }
      expect(copy.rotation).toEqual(original.rotation);
    }
    await attachEvidence(page, 'uniform-multiselect');
  } finally {
    await attachLastObservation(page);
    await page.mouse.up();
    await deleteSpace(page, id);
  }
});

test('Activity releases the hidden canvas and reconstructs it on the retained personal view', async ({ page }) => {
  const id = await openScene(page, `native-activity-${Date.now()}`);
  let other: string | null = null;
  try {
    const objects = await place(page, 'figure', 1);
    const canvas = viewport(page);
    const originalCanvas = await canvas.elementHandle();
    const originalHost = await visibleSpace(page).getByTestId('three-d-viewport-host').elementHandle();
    const box = await canvas.boundingBox();
    if (!originalCanvas || !originalHost || !box) throw new Error('The first visible viewport is incomplete');
    const initial = await settledView(page);
    const pointer = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.2 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), pointer)).toBe('three-d-viewport');
    await page.mouse.move(pointer.x, pointer.y);
    await page.mouse.wheel(0, -180);
    await expect.poll(async () => JSON.parse(await canvas.getAttribute('data-view') ?? 'null') as PersonalView).not.toEqual(initial);
    const saved = await settledView(page);

    other = await createSpace(page, 'canvas', `native-away-${Date.now()}`);
    await expect.poll(() => originalCanvas.evaluate((element) => element.isConnected)).toBe(false);
    expect(await originalHost.evaluate((element) => element.isConnected)).toBe(true);
    await page.getByTestId(`space-tab-${id}`).click();
    await expect(viewport(page)).toBeVisible();
    await expect.poll(async () => (await rendered(page)).length).toBe(1);
    expect(await viewport(page).evaluate((element, old) => element === old, originalCanvas)).toBe(false);
    expect(await visibleSpace(page).getByTestId('three-d-viewport-host').evaluate((element, old) => element === old, originalHost)).toBe(true);
    const restored = await settledView(page);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(restored.position[axis]).toBeCloseTo(saved.position[axis], 6);
      expect(restored.target[axis]).toBeCloseTo(saved.target[axis], 6);
    }
    expect(await rendered(page)).toEqual(objects);
    await expect(viewport(page)).toHaveAttribute('data-gesture-active', 'false');
    await attachEvidence(page, 'activity-restored');
  } finally {
    await attachLastObservation(page);
    if (other !== null) await deleteSpace(page, other);
    await deleteSpace(page, id);
  }
});

test('focus frames distant models within a narrow viewport and restores the distant personal camera', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 960 });
  const id = await openScene(page, `native-distant-${Date.now()}`);
  try {
    await place(page, 'block', 1);
    const firstId = (await rendered(page))[0].id;
    for (const axis of ['X', 'Y', 'Z']) {
      const field = page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Scale', exact: true }).getByLabel(axis, { exact: true });
      await field.fill('500'); await field.press('Tab');
    }
    await place(page, 'block', 2);
    for (const axis of ['X', 'Y', 'Z']) {
      const field = page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Scale', exact: true }).getByLabel(axis, { exact: true });
      await field.fill('500'); await field.press('Tab');
    }
    const x = page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Position (m)', exact: true }).getByLabel('X', { exact: true });
    await x.fill('10000'); await x.press('Tab');
    await visibleSpace(page).getByTestId('scene-objects-trigger').click();
    await page.getByTestId(`scene-object-${firstId}`).click({ modifiers: ['Shift'] });
    await visibleSpace(page).getByRole('button', { name: 'Focus selection', exact: true }).click();
    await settledView(page);
    const observed = await native(page);
    const projection = new Matrix4().fromArray(observed.projectionMatrix);
    const view = new Matrix4().fromArray(observed.matrixWorldInverse);
    for (const object of await rendered(page)) {
      for (const dx of [-250, 250]) for (const dy of [-250, 250]) for (const dz of [-250, 250]) {
        const projected = new Vector3(object.position[0] + dx, object.position[1] + dy, object.position[2] + dz).applyMatrix4(view).applyMatrix4(projection);
        expect(projected.toArray().every((value) => Number.isFinite(value) && Math.abs(value) < 1)).toBe(true);
      }
    }
    await attachEvidence(page, 'distant-focus');
    const personalView = await settledView(page);
    await page.reload();
    await expect(viewport(page)).toBeVisible();
    await expect.poll(async () => (await rendered(page)).length).toBe(2);
    const restored = await settledView(page);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(restored.position[axis]).toBeCloseTo(personalView.position[axis], 5);
      expect(restored.target[axis]).toBeCloseTo(personalView.target[axis], 5);
    }
    const restoredNative = await native(page);
    const center = new Vector3(5000, 0, 0)
      .applyMatrix4(new Matrix4().fromArray(restoredNative.matrixWorldInverse))
      .applyMatrix4(new Matrix4().fromArray(restoredNative.projectionMatrix));
    expect(Math.abs(center.z)).toBeLessThan(1);
    await attachEvidence(page, 'distant-restored');
  } finally {
    await deleteSpace(page, id);
  }
});

test('the actual GPU viewport fills its stage and paints distinct semantic light and dark themes', async ({ page }) => {
  const id = await openScene(page, `native-themes-${Date.now()}`);
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  try {
    await place(page, 'figure', 1);
    const screenshots: Buffer[] = [];
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await renderedFrames(page);
      const expected = await viewport(page).evaluate((canvas) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-background)';
        canvas.parentElement!.append(probe);
        const value = getComputedStyle(probe).color.replaceAll(' ', '');
        probe.remove();
        return value;
      });
      await expect.poll(async () => (await native(page)).background.replaceAll(' ', '')).toBe(expected);
      const stage = await visibleSpace(page).getByTestId('scene-stage').boundingBox();
      const host = await visibleSpace(page).getByTestId('three-d-viewport-host').boundingBox();
      const canvas = await viewport(page).boundingBox();
      if (!stage || !host || !canvas) throw new Error('The themed viewport has no measurable geometry');
      for (const key of ['x', 'y', 'width', 'height'] as const) {
        expect(canvas[key]).toBeCloseTo(host[key], 1);
        expect(canvas[key]).toBeCloseTo(stage[key], 1);
      }
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);
      const observed = await native(page);
      expect(observed.projectionMatrix).toHaveLength(16);
      expect(observed.matrixWorldInverse).toHaveLength(16);
      expect([...observed.projectionMatrix, ...observed.matrixWorldInverse].every(Number.isFinite)).toBe(true);
      await attachEvidence(page, `theme-${theme}`);
      screenshots.push(await viewport(page).screenshot());
      await test.info().attach(`theme-${theme}-geometry`, { body: JSON.stringify({ stage, host, canvas }), contentType: 'application/json' });
    }
    expect(screenshots[0].equals(screenshots[1])).toBe(false);
  } finally {
    await attachLastObservation(page);
    await page.evaluate((theme) => {
      if (theme === null) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
    }, originalTheme);
    await deleteSpace(page, id);
  }
});
