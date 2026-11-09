// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { liveModuleUrl } from '../helpers/live-module';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type * as SceneSessionModule from '../../src/data/yjs/scene-session';
import { POSE_PRESETS } from '../../src/spaces/three-d/viewport/pose-presets';

interface Joint { key: string; center: number[]; selected: boolean }

/**
 * The joint dots the viewport draws, with their projected centres.
 * @param page - A page showing the scene.
 * @returns The dots, empty outside joint mode.
 */
async function joints(page: Page): Promise<Joint[]> {
  return JSON.parse(await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-joints') ?? '[]') as Joint[];
}

/**
 * Rendered object transforms.
 * @param page - A page showing the scene.
 * @returns Each object's id and position.
 */
async function rendered(page: Page): Promise<Array<{ id: string; position: number[] }>> {
  return JSON.parse(await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-objects') ?? '[]') as Array<{ id: string; position: number[] }>;
}

/**
 * Every object's committed pose, in document order, read from the app's own live session.
 * @param page - A page showing the scene.
 * @param spaceId - The 3D Space.
 * @returns The poses as stored, absent keys left out.
 */
async function committedPoses(page: Page, spaceId: string): Promise<Array<Record<string, readonly number[]>>> {
  const managerAt = await liveModuleUrl(page, 'data/yjs/manager.ts');
  const sceneAt = await liveModuleUrl(page, 'data/yjs/scene-session.ts');
  return page.evaluate(async ({ managerAt, sceneAt, projectId, spaceId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as typeof ManagerModule;
    const scene = await import(/* @vite-ignore */ sceneAt) as typeof SceneSessionModule;
    const session = scene.peekSceneSession(manager.docName.threeDSpace(projectId, spaceId));
    if (!session || session.getSnapshot().status !== 'ready') throw new Error('The displayed scene has no live ready session.');
    return session.getSnapshot().objects.map((object) => ({ ...object.pose }));
  }, { managerAt, sceneAt, projectId: smokeProjectId(), spaceId });
}

/**
 * The first object's committed pose.
 * @param page - A page showing the scene.
 * @param spaceId - The 3D Space.
 * @returns The pose as stored, absent keys left out.
 */
async function committedPose(page: Page, spaceId: string): Promise<Record<string, readonly number[]>> {
  return (await committedPoses(page, spaceId))[0];
}

/**
 * A projected point in page pixels.
 * @param page - A page showing the scene.
 * @param ndc - Normalized device coordinates.
 * @returns The page point.
 */
async function toPage(page: Page, ndc: readonly number[]): Promise<{ x: number; y: number }> {
  const box = await visibleSpace(page).getByTestId('three-d-viewport').boundingBox();
  if (!box) throw new Error('The viewport has no box.');
  return { x: box.x + (ndc[0] + 1) / 2 * box.width, y: box.y + (1 - ndc[1]) / 2 * box.height };
}

/**
 * Where a joint's dot is now.
 * @param page - A page in joint mode.
 * @param key - The joint's pose key.
 * @returns Its centre, x and y in normalized device coordinates.
 */
async function jointAt(page: Page, key: string): Promise<number[]> {
  const joint = (await joints(page)).find((candidate) => candidate.key === key);
  if (!joint) throw new Error(`No dot for ${key}.`);
  return joint.center.slice(0, 2);
}

/**
 * Press a rotation ring around the selected joint and drag along it, reading
 * the peer while the drag lasts.
 * @param page - The dragging page.
 * @param ring - Which of the hoverable rings to take, in search order.
 * @param during - Called after each step while the pointer is still down.
 * @returns Whether that ring was found.
 */
async function dragRing(page: Page, ring: number, during: () => Promise<void> = async () => {}): Promise<boolean> {
  const canvas = visibleSpace(page).getByTestId('three-d-viewport');
  const native = JSON.parse(await canvas.getAttribute('data-native-controls') ?? '{}') as { center: number[] };
  const centre = await toPage(page, native.center);
  // The rotate gizmo keeps a fixed screen size; find a ring that the pointer hovers.
  const used = new Set<string>();
  for (let radius = 56; radius <= 120; radius += 4) {
    for (const [dx, dy] of [[1, 0], [0, -1], [-1, 0], [0, 1]]) {
      await page.mouse.move(centre.x + dx * radius, centre.y + dy * radius);
      const axis = (JSON.parse(await canvas.getAttribute('data-native-controls') ?? '{}') as { axis: string | null }).axis;
      if (axis !== 'X' && axis !== 'Y' && axis !== 'Z') continue;
      if (used.has(axis)) continue;
      used.add(axis);
      if (used.size <= ring) continue;
      await page.mouse.down();
      for (let step = 1; step <= 12; step += 1) {
        // Along the ring's tangent at that point.
        await page.mouse.move(centre.x + dx * radius - dy * step * 6, centre.y + dy * radius + dx * step * 6, { steps: 2 });
        await during();
      }
      await page.mouse.up();
      return true;
    }
  }
  return false;
}

/**
 * Bend the selected joint so that its child moves on screen: a ring that only
 * twists the bone leaves the child where it is, so rings are tried in turn.
 * @param page - The dragging page.
 * @param child - The pose key of the dot that must move.
 * @param during - Called after each step while the pointer is still down.
 * @returns Nothing.
 */
async function bendJoint(page: Page, child: string, during: () => Promise<void> = async () => {}): Promise<void> {
  for (let ring = 0; ring < 3; ring += 1) {
    const before = await jointAt(page, child);
    if (!await dragRing(page, ring, during)) break;
    const after = await jointAt(page, child);
    if (Math.hypot(after[0] - before[0], after[1] - before[1]) > 0.01) return;
  }
  throw new Error(`No rotation ring around the selected joint moved ${child}.`);
}

/**
 * Open a fresh 3D Space with one built-in figure selected.
 * @param page - The page.
 * @param label - Space name prefix.
 * @returns The Space id.
 */
async function sceneWithFigure(page: Page, label: string): Promise<string> {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `${label}-${Date.now()}`);
  await visibleSpace(page).getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
  await expect(page.getByTestId('scene-pose-section')).toBeVisible({ timeout: 30_000 });
  return id;
}

test('the built-in figure takes presets, bends a joint that stays after reload, and Escape leaves joint mode first', async ({ page }) => {
  const id = await sceneWithFigure(page, 'scene-pose');
  try {
    const section = page.getByTestId('scene-pose-section');
    for (const name of ['Stand', 'Sit', 'Lie down', 'Walk', 'Wave']) await expect(section.getByRole('button', { name, exact: true })).toBeEnabled();
    await section.getByRole('button', { name: 'Stand', exact: true }).click();
    const jointMode = page.getByTestId('scene-pose-joint-mode');
    await jointMode.click();
    await expect.poll(async () => (await joints(page)).length).toBeGreaterThanOrEqual(15);
    // The object handles give way to the joint's rings.
    const elbow = await toPage(page, await jointAt(page, 'h:leftLowerArm'));
    await page.mouse.click(elbow.x, elbow.y);
    await expect.poll(async () => (await joints(page)).find((joint) => joint.selected)?.key).toBe('h:leftLowerArm');
    await bendJoint(page, 'h:leftHand');
    const bent = await jointAt(page, 'h:leftHand');
    await expect(visibleSpace(page).getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();

    await page.reload();
    await expect.poll(async () => (await rendered(page)).length, { timeout: 30_000 }).toBe(1);
    await visibleSpace(page).getByTestId('scene-objects-trigger').click();
    await page.getByTestId(`scene-object-${(await rendered(page))[0].id}`).click();
    await page.getByTestId('scene-pose-joint-mode').click();
    await expect.poll(async () => (await jointAt(page, 'h:leftHand').catch(() => [9, 9])).map((value) => value.toFixed(3)))
      .toEqual(bent.map((value) => value.toFixed(3)));

    const canvas = visibleSpace(page).getByTestId('three-d-viewport');
    await canvas.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('scene-pose-joint-mode')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('scene-right-panel')).toBeVisible();
    expect(await joints(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('scene-right-panel')).toHaveCount(0);
  } finally {
    await deleteSpace(page, id);
  }
});

test('a second connection sees the real figure move and bend while the drag lasts', async ({ page, browser, baseURL }) => {
  const id = await sceneWithFigure(page, 'scene-pose-live');
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('A') });
  const peer = await peerContext.newPage();
  try {
    await peer.goto(smokeProjectUrl());
    await peer.getByTestId('space-drawer-trigger').click();
    await peer.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(peer.getByTestId('space-drawer')).toHaveCount(0);
    // The figure model loads on this connection as well.
    await expect.poll(async () => (await rendered(peer)).length, { timeout: 30_000 }).toBe(1);
    const objectId = (await rendered(peer))[0].id;
    await visibleSpace(peer).getByTestId('scene-objects-trigger').click();
    await peer.getByTestId(`scene-object-${objectId}`).click();
    await peer.getByTestId('scene-pose-joint-mode').click();
    await expect.poll(async () => (await joints(peer)).length).toBeGreaterThanOrEqual(15);

    // Moving: drag the vertical arrow and read the peer before releasing.
    const canvas = visibleSpace(page).getByTestId('three-d-viewport');
    const native = JSON.parse(await canvas.getAttribute('data-native-controls') ?? '{}') as { center: number[] };
    const centre = await toPage(page, native.center);
    await page.mouse.move(centre.x, centre.y - 55);
    await page.mouse.down();
    const seen: number[] = [];
    for (let step = 1; step <= 15; step += 1) {
      await page.mouse.move(centre.x, centre.y - 55 - step * 6);
      seen.push((await rendered(peer))[0]?.position[1] ?? 0);
    }
    await expect.poll(async () => (await rendered(peer))[0]?.position[1]).toBeGreaterThan(0.05);
    const peerDuring = (await rendered(peer))[0].position[1];
    await page.mouse.up();
    expect(Math.max(...seen, peerDuring)).toBeGreaterThan(0.05);
    await expect.poll(async () => (await rendered(peer))[0].position[1]).toBeCloseTo((await rendered(page))[0].position[1], 6);

    // Bending: drag a joint ring and read the peer's dot before releasing.
    await page.getByTestId('scene-pose-joint-mode').click();
    const elbow = await toPage(page, await jointAt(page, 'h:leftLowerArm'));
    await page.mouse.click(elbow.x, elbow.y);
    await expect.poll(async () => (await joints(page)).find((joint) => joint.selected)?.key).toBe('h:leftLowerArm');
    const before = await jointAt(peer, 'h:leftHand');
    let movedDuring = 0;
    await bendJoint(page, 'h:leftHand', async () => {
      const now = await jointAt(peer, 'h:leftHand');
      movedDuring = Math.max(movedDuring, Math.hypot(now[0] - before[0], now[1] - before[1]));
    });
    expect(movedDuring).toBeGreaterThan(0.005);
    // After release both sides hold the same committed pose, with the bent elbow in it.
    const mine = await committedPose(page, id);
    expect(mine['h:leftLowerArm']).toBeDefined();
    await expect.poll(() => committedPose(peer, id)).toEqual(mine);
    // The peer keeps showing the bend once the drag's preview is withdrawn.
    const settled = await jointAt(peer, 'h:leftHand');
    expect(Math.hypot(settled[0] - before[0], settled[1] - before[1])).toBeGreaterThan(0.005);
  } finally {
    await peerContext.close();
    await deleteSpace(page, id);
  }
});

test('a seated figure is still seated after a reload, and reset, duplicate and undo each act on one figure', async ({ page }) => {
  const id = await sceneWithFigure(page, 'scene-pose-sit');
  try {
    const section = page.getByTestId('scene-pose-section');
    await section.getByRole('button', { name: 'Sit', exact: true }).click();
    await expect.poll(() => committedPose(page, id)).toEqual(POSE_PRESETS.sit);

    await page.reload();
    await expect.poll(async () => (await rendered(page)).length, { timeout: 30_000 }).toBe(1);
    await expect.poll(() => committedPose(page, id)).toEqual(POSE_PRESETS.sit);
    await visibleSpace(page).getByTestId('scene-objects-trigger').click();
    const original = (await rendered(page))[0].id;
    await page.getByTestId(`scene-object-${original}`).click();
    // Seated on the ground with the knees raised: on screen each knee is above its hip.
    await page.getByTestId('scene-pose-joint-mode').click();
    await expect.poll(async () => (await joints(page)).length).toBeGreaterThanOrEqual(15);
    for (const side of ['left', 'right']) {
      expect((await jointAt(page, `h:${side}LowerLeg`))[1], side).toBeGreaterThan((await jointAt(page, `h:${side}UpperLeg`))[1]);
    }
    await page.getByTestId('scene-pose-joint-mode').click();

    await page.getByTestId('scene-pose-reset').click();
    await expect.poll(() => committedPose(page, id)).toEqual({});
    const undo = visibleSpace(page).getByRole('button', { name: 'Undo', exact: true });
    await undo.click();
    await expect.poll(() => committedPose(page, id)).toEqual(POSE_PRESETS.sit);

    await visibleSpace(page).getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect.poll(async () => (await rendered(page)).length, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => committedPoses(page, id)).toEqual([POSE_PRESETS.sit, POSE_PRESETS.sit]);
    // The copy is selected; waving it leaves the original seated.
    await page.getByTestId('scene-pose-section').getByRole('button', { name: 'Wave', exact: true }).click();
    await expect.poll(() => committedPoses(page, id)).toEqual([POSE_PRESETS.sit, POSE_PRESETS.wave]);
    await undo.click();
    await expect.poll(() => committedPoses(page, id)).toEqual([POSE_PRESETS.sit, POSE_PRESETS.sit]);
  } finally {
    await deleteSpace(page, id);
  }
});
