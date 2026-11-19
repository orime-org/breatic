// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part appearance in a 3D Space (inner#1693): presets and colours on a part, undo, reload, picking a part in the
 * scene, copies, resets, the figure's parts, a Viewer and a locked object.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { liveModuleUrl } from '../helpers/live-module';
import { roomForUploads } from '../helpers/upload-budget';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { credentialsFor } from '../helpers/credentials';
import { dataOf } from '../helpers/api';
import { uniquePicture } from '../helpers/upload';
import { handleUnder } from '../helpers/scene-viewport';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type * as SceneSessionModule from '../../src/data/yjs/scene-session';

interface DrawnPart { type: string; color: string | null; map: boolean }
interface Rendered { id: string; parts: Record<string, DrawnPart> }

const FIXTURES = join(__dirname, '..', 'fixtures');
const METAL = { roughness: 0.15, metalness: 1, opacity: 1, transmission: 0 };
const GLASS = { roughness: 0.05, metalness: 0, opacity: 1, transmission: 1 };

/**
 * What the viewport draws for each object's parts.
 * @param page - A page showing the scene.
 * @returns Each object's id and drawn parts.
 */
async function rendered(page: Page): Promise<Rendered[]> {
  return JSON.parse(await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-objects') ?? '[]') as Rendered[];
}

/**
 * Every object's committed look, in document order, read from the app's own live session.
 * @param page - A page showing the scene.
 * @param spaceId - The 3D Space.
 * @returns The looks as stored; an object without one gives {}.
 */
async function committedLooks(page: Page, spaceId: string): Promise<Array<Record<string, Record<string, unknown>>>> {
  const managerAt = await liveModuleUrl(page, 'data/yjs/manager.ts');
  const sceneAt = await liveModuleUrl(page, 'data/yjs/scene-session.ts');
  return page.evaluate(async ({ managerAt, sceneAt, projectId, spaceId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as typeof ManagerModule;
    const scene = await import(/* @vite-ignore */ sceneAt) as typeof SceneSessionModule;
    const session = scene.peekSceneSession(manager.docName.threeDSpace(projectId, spaceId));
    if (!session || session.getSnapshot().status !== 'ready') throw new Error('The displayed scene has no live ready session.');
    return session.getSnapshot().objects.map((object) => ({ ...object.look }));
  }, { managerAt, sceneAt, projectId: smokeProjectId(), spaceId });
}

/**
 * Open a fresh 3D Space with one built-in box selected and its parts listed.
 * @param page - The page.
 * @param label - Space name prefix.
 * @returns The Space id.
 */
async function sceneWithBox(page: Page, label: string): Promise<string> {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `${label}-${Date.now()}`);
  await visibleSpace(page).getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add block', exact: true }).click();
  await expect(page.getByTestId('scene-look-part-0')).toBeVisible({ timeout: 30_000 });
  return id;
}

/**
 * Set the selected part's colour through the colour field's text box.
 * @param page - The page.
 * @param hex - The colour.
 */
async function setPartColor(page: Page, hex: string): Promise<void> {
  const swatch = page.getByTestId('scene-look-part-fields').getByRole('button', { name: 'Colour', exact: true });
  await swatch.click();
  // The swatch names the popover it opens; the right panel around it is a popover of its own.
  const popover = await swatch.getAttribute('aria-controls');
  if (!popover) throw new Error('The colour swatch names no popover.');
  const box = page.locator(`[id="${popover}"] input`);
  await box.fill(hex);
  await box.press('Enter');
  await page.keyboard.press('Escape');
}

/**
 * The selected object's handle centre on the page.
 * @param page - The page with one object selected.
 * @returns The point.
 * @throws {Error} When the viewport has no box.
 */
async function selectedCentre(page: Page): Promise<{ x: number; y: number }> {
  const canvas = visibleSpace(page).getByTestId('three-d-viewport');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('The viewport has no box.');
  const native = JSON.parse(await canvas.getAttribute('data-native-controls') ?? '{}') as { center: number[] };
  return { x: box.x + (native.center[0] + 1) / 2 * box.width, y: box.y + (1 - native.center[1]) / 2 * box.height };
}

/**
 * The mean colour of a few screen pixels around a point, as the page shows them.
 * @param page - The page.
 * @param point - The point.
 * @returns The mean red, green and blue.
 */
async function meanColour(page: Page, point: { x: number; y: number }): Promise<[number, number, number]> {
  const png = await page.screenshot({ clip: { x: point.x - 3, y: point.y - 3, width: 6, height: 6 } });
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel += 1) sum[channel] += data[i + channel]!;
    const count = data.length / 4;
    return sum.map((value) => value / count) as [number, number, number];
  }, png.toString('base64'));
}

/**
 * A point on the selected box's faces that the transform handles do not answer, with the pointer left on it.
 * @param page - The page with one object selected.
 * @returns The point.
 * @throws {Error} When no point near the object's centre is free of the handles.
 */
async function freeFacePoint(page: Page): Promise<{ x: number; y: number }> {
  const canvas = visibleSpace(page).getByTestId('three-d-viewport');
  const centre = await selectedCentre(page);
  // The box stands on its origin, so its faces are above the handle centre.
  for (const [dx, dy] of [[-14, -30], [14, -30], [-20, -18], [20, -18], [0, -40], [-8, -48]]) {
    const point = { x: centre.x + dx!, y: centre.y + dy! };
    if (await handleUnder(page, canvas, point) === null) return point;
  }
  throw new Error('No point on the object is free of the transform handles.');
}

/**
 * Click the selected object in the scene at a point the transform handles do not answer.
 * @param page - The page with one object selected.
 * @param shift - Whether Shift is held.
 */
async function clickSelectedObject(page: Page, shift = false): Promise<void> {
  const point = await freeFacePoint(page);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(point.x, point.y);
  if (shift) await page.keyboard.up('Shift');
}

test('a box part takes a preset and a colour, undo takes back one step, and the look stays after reload', async ({ page }) => {
  const id = await sceneWithBox(page, 'scene-look-preset');
  try {
    await expect.poll(async () => (await rendered(page))[0]?.parts['0']?.type).toBe('MeshStandardMaterial');
    await page.getByTestId('scene-look-part-0').click();
    await page.getByTestId('scene-look-preset-glass').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: GLASS }]);
    // Glass lets light through, which takes the physical material.
    await expect.poll(async () => (await rendered(page))[0].parts['0'].type).toBe('MeshPhysicalMaterial');
    await expect(page.getByTestId('scene-look-modified-0')).toBeVisible();
    // The glass face is drawn, neither black nor NaN (which draws black). The part is let go first, so its highlight
    // tint is not what is read, and the point is one the handles leave clear.
    await page.getByTestId('scene-look-part-0').click();
    await expect(visibleSpace(page).getByTestId('three-d-viewport')).toHaveAttribute('data-part-highlight', '0');
    const point = await freeFacePoint(page);
    const glass = await meanColour(page, point);
    expect(Math.min(...glass), `glass face colour ${glass.join(',')}`).toBeGreaterThan(60);
    // A click on that point picks the part, so the pixels read were the box's face.
    await page.mouse.click(point.x, point.y);
    await expect(page.getByTestId('scene-look-part-0')).toHaveAttribute('aria-pressed', 'true');

    await setPartColor(page, '#ff0000');
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: { ...GLASS, color: '#ff0000' } }]);
    await expect.poll(async () => (await rendered(page))[0].parts['0'].color).toBe('#ff0000');

    await visibleSpace(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: GLASS }]);
    await expect.poll(async () => (await rendered(page))[0].parts['0'].color).not.toBe('#ff0000');

    await page.reload();
    await expect.poll(async () => (await rendered(page)).length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: GLASS }]);
    await expect.poll(async () => (await rendered(page))[0].parts['0'].type).toBe('MeshPhysicalMaterial');
  } finally {
    await deleteSpace(page, id);
  }
});

test('clicking the only selected object picks its part and tints it; Shift-click selects as before', async ({ page }) => {
  const id = await sceneWithBox(page, 'scene-look-pick');
  try {
    const canvas = visibleSpace(page).getByTestId('three-d-viewport');
    await expect.poll(async () => (await rendered(page)).length).toBe(1);
    await expect(canvas).toHaveAttribute('data-part-highlight', '0');
    await clickSelectedObject(page);
    await expect(page.getByTestId('scene-look-part-0')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('scene-look-part-fields')).toBeVisible();
    await expect.poll(async () => Number(await canvas.getAttribute('data-part-highlight'))).toBeGreaterThan(0);

    // Shift-click toggles the object out of the selection and drops the part with it.
    await clickSelectedObject(page, true);
    await expect(page.getByTestId('scene-look-section')).toHaveCount(0);
    await expect(canvas).toHaveAttribute('data-part-highlight', '0');
  } finally {
    await deleteSpace(page, id);
  }
});

test('a copy keeps the look and changes on its own; reset part and reset all write back the model', async ({ page }) => {
  const id = await sceneWithBox(page, 'scene-look-copy');
  try {
    await page.getByTestId('scene-look-part-0').click();
    await page.getByTestId('scene-look-preset-metal').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: METAL }]);

    await visibleSpace(page).getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect.poll(async () => (await rendered(page)).length, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: METAL }, { 0: METAL }]);
    // The copy is selected: changing it leaves the original as it was.
    await page.getByTestId('scene-look-part-0').click();
    await page.getByTestId('scene-look-preset-glass').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: METAL }, { 0: GLASS }]);

    await page.getByTestId('scene-look-reset-part').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: METAL }, {}]);
    await expect(page.getByTestId('scene-look-reset-all')).toBeDisabled();
    await page.getByTestId('scene-look-preset-glass').click();
    await page.getByTestId('scene-look-reset-all').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 0: METAL }, {}]);
    await expect.poll(async () => (await rendered(page))[1]?.parts['0']?.type).toBe('MeshStandardMaterial');
  } finally {
    await deleteSpace(page, id);
  }
});

test('a figure lists its three parts and one of them takes a preset', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-look-figure-${Date.now()}`);
  try {
    await visibleSpace(page).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    for (const part of ['0', '1', '2']) await expect(page.getByTestId(`scene-look-part-${part}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('scene-look-part-3')).toHaveCount(0);
    await page.getByTestId('scene-look-part-1').click();
    await page.getByTestId('scene-look-preset-metal').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{ 1: METAL }]);
    await expect.poll(async () => Object.keys((await rendered(page))[0]?.parts ?? {}).sort()).toEqual(['0', '1', '2']);
  } finally {
    await deleteSpace(page, id);
  }
});

test('a Viewer sees a part change at once and can read the parts with every setting greyed; a locked object greys them too', async ({ page, browser, baseURL }) => {
  const id = await sceneWithBox(page, 'scene-look-peer');
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
  const projectId = smokeProjectId();
  const memberId = (await dataOf<{ id: string }>(await peerContext.request.get('/api/v1/auth/me'), 'peer identity')).id;
  try {
    const peer = await inviteMember(page, peerContext, projectId, credentialsFor('B').email, 'viewer');
    await peer.goto(smokeProjectUrl());
    await peer.getByTestId('space-drawer-trigger').click();
    await peer.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(peer.getByTestId('space-drawer')).toHaveCount(0);
    await expect.poll(async () => (await rendered(peer)).length, { timeout: 30_000 }).toBe(1);

    await page.getByTestId('scene-look-part-0').click();
    await setPartColor(page, '#00ff00');
    await expect.poll(() => committedLooks(peer, id)).toEqual([{ 0: { color: '#00ff00' } }]);
    await expect.poll(async () => (await rendered(peer))[0].parts['0'].color).toBe('#00ff00');

    // The Viewer selects the box from the object list and reads its parts; nothing can be changed.
    const [box] = await rendered(peer);
    await peer.getByTestId('scene-objects-trigger').click();
    await peer.getByTestId(`scene-object-${box!.id}`).click();
    await peer.getByTestId('scene-look-part-0').click();
    await expect(peer.getByTestId('scene-look-part-fields')).toBeVisible();
    await expect(peer.getByTestId('scene-look-preset-metal')).toBeDisabled();
    await expect(peer.getByTestId('scene-look-reset-all')).toBeDisabled();

    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByTestId('scene-look-part-0')).toBeEnabled();
    await expect(page.getByTestId('scene-look-preset-metal')).toBeDisabled();
    await expect(page.getByTestId('scene-look-reset-all')).toBeDisabled();
    await expect(page.getByTestId('scene-look-reset-part')).toBeDisabled();
  } finally {
    await peerContext.close();
    await deleteSpace(page, id);
    await cleanMembership(page, projectId, memberId);
  }
});

test('a picture from the computer uploads onto the part it was chosen for @needs-storage @needs-ingest', async ({ page }) => {
  const id = await sceneWithBox(page, 'scene-look-upload');
  try {
    await page.getByTestId('scene-look-part-0').click();
    await roomForUploads(1);
    await page.getByTestId('scene-look-choose-image').click();
    await page.getByTestId('scene-image-picker-local').click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose file', exact: true }).click();
    await (await chooser).setFiles({ name: 'pattern.png', mimeType: 'image/png', buffer: uniquePicture(readFileSync(join(FIXTURES, 'portrait.png'))) });

    await expect.poll(async () => {
      const [look] = await committedLooks(page, id);
      return typeof look?.['0']?.map === 'string' && look['0'].map !== 'none';
    }, { timeout: 60_000 }).toBe(true);
    // The picture shows on the part at white, its colours its own.
    await expect.poll(async () => (await rendered(page))[0].parts['0'], { timeout: 60_000 }).toMatchObject({ map: true, color: '#ffffff' });
    await expect(page.getByTestId('scene-look-remove-image')).toBeVisible();

    const [uploaded] = await committedLooks(page, id);
    const assetId = uploaded?.['0']?.map as string;

    await page.getByTestId('scene-look-remove-image').click();
    await expect.poll(() => committedLooks(page, id)).toEqual([{}]);
    await expect.poll(async () => (await rendered(page))[0].parts['0'].map).toBe(false);

    // The uploaded picture is now one of the Project's pictures, and picking it puts it back.
    await page.getByTestId('scene-look-choose-image').click();
    await page.getByTestId('scene-image-picker-project').click();
    await page.getByTestId(`scene-image-picker-item-${assetId}`).click();
    await expect.poll(() => committedLooks(page, id), { timeout: 30_000 }).toEqual([{ 0: { map: assetId } }]);
    await expect.poll(async () => (await rendered(page))[0].parts['0'], { timeout: 60_000 }).toMatchObject({ map: true, color: '#ffffff' });
  } finally {
    await deleteSpace(page, id);
  }
});
