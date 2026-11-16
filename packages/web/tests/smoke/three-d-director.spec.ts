// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The director console of a 3D Space (inner#1694 design 10): saving the view as
 * a camera, setting its lens and frame, looking through it, piloting it and
 * copying a still; adding a light, turning its shadow off and deleting it back
 * to default lighting; and a second account seeing the cameras and lights.
 */

import { expect, type Page } from 'playwright/test';
import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { credentialsFor } from '../helpers/credentials';
import { dataOf } from '../helpers/api';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { liveModuleUrl } from '../helpers/live-module';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type * as SceneSessionModule from '../../src/data/yjs/scene-session';

interface Record { id: string; model: { kind: string; type?: string }; position: number[]; number?: number; focalLength?: number; frame?: string; castShadow?: boolean }

/**
 * Read the committed cameras and lights of the displayed scene through the app's own session.
 * @param page - A page showing the scene.
 * @param spaceId - The 3D Space.
 * @returns Its camera and light records.
 */
async function directorRecords(page: Page, spaceId: string): Promise<Record[]> {
  const managerAt = await liveModuleUrl(page, 'data/yjs/manager.ts');
  const sceneAt = await liveModuleUrl(page, 'data/yjs/scene-session.ts');
  return page.evaluate(async ({ managerAt, sceneAt, projectId, spaceId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as typeof ManagerModule;
    const scene = await import(/* @vite-ignore */ sceneAt) as typeof SceneSessionModule;
    const session = scene.peekSceneSession(manager.docName.threeDSpace(projectId, spaceId));
    if (!session || session.getSnapshot().status !== 'ready') throw new Error('The displayed scene has no live ready session.');
    return session.getSnapshot().objects.filter((object) => object.model.kind === 'camera' || object.model.kind === 'light') as unknown as Record[];
  }, { managerAt, sceneAt, projectId: smokeProjectId(), spaceId });
}

/**
 * Add a block and open the director console.
 * @param page - The owner's page on the new scene.
 */
async function openDirector(page: Page): Promise<void> {
  const space = visibleSpace(page);
  await space.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add block', exact: true }).click();
  await expect(space.getByTestId('three-d-viewport')).toBeVisible();
  await space.getByTestId('scene-director-trigger').click();
  await expect(page.getByTestId('scene-director-panel')).toBeVisible();
}

test('a saved camera takes a lens and frame, is looked through, piloted and gives a still', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `director-camera-${Date.now()}`);
  try {
    await openDirector(page);
    const panel = page.getByTestId('scene-director-panel');
    await expect(panel).toContainText('Save this view as a camera to see what it shoots here.');
    await panel.getByRole('button', { name: 'Save this view as a camera', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id)).length).toBe(1);
    const [camera] = await directorRecords(page, id);
    expect(camera).toMatchObject({ model: { kind: 'camera' }, number: 1, frame: '16:9' });
    const cameraId = camera!.id;
    await expect(panel.getByTestId(`scene-director-monitor-${cameraId}`).locator('canvas')).toHaveAttribute('data-drawn', 'true', { timeout: 15_000 });

    const card = panel.getByTestId(`scene-director-camera-${cameraId}`);
    await card.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Properties', exact: true }).click();
    const fields = page.getByTestId(`scene-director-fields-${cameraId}`).first();
    await fields.getByRole('combobox').first().click();
    await page.getByRole('option', { name: '50 mm', exact: true }).click();
    await fields.getByRole('combobox').nth(1).click();
    await page.getByRole('option', { name: '9:16', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id))[0]).toMatchObject({ focalLength: 50, frame: '9:16' });

    await panel.getByTestId(`scene-director-monitor-${cameraId}`).click();
    const menu = visibleSpace(page).getByTestId('scene-viewfinder-menu');
    await expect(menu.getByRole('button', { name: 'Exit camera', exact: true })).toBeVisible();
    const frame = await visibleSpace(page).getByTestId('scene-viewfinder-frame').boundingBox();
    expect((frame?.width ?? 0) / (frame?.height ?? 1)).toBeCloseTo(9 / 16, 1);

    const before = (await directorRecords(page, id))[0]!.position;
    const viewport = await visibleSpace(page).getByTestId('three-d-viewport').boundingBox();
    if (!viewport) throw new Error('The viewport has no box.');
    const x = viewport.x + viewport.width / 2;
    const y = viewport.y + viewport.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y, { steps: 5 });
    await page.mouse.move(x + 120, y + 20, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await directorRecords(page, id))[0]!.position).not.toEqual(before);
    await visibleSpace(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id))[0]!.position).toEqual(before);

    await menu.getByRole('button', { name: 'Capture', exact: true }).click();
    await menu.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => (await navigator.clipboard.read()).flatMap((item) => [...item.types]))).toContain('image/png');
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('scene-director-panel')).toBeVisible();
  } finally {
    await deleteSpace(page, id);
  }
});

test('a light is added, its shadow turned off, and deleting it brings back default lighting', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `director-light-${Date.now()}`);
  try {
    await openDirector(page);
    const panel = page.getByTestId('scene-director-panel');
    await expect(panel).toContainText('No lights yet. The scene uses default lighting.');
    await panel.getByRole('button', { name: 'Add light', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Spotlight', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id)).length).toBe(1);
    const [light] = await directorRecords(page, id);
    expect(light).toMatchObject({ model: { kind: 'light', type: 'spot' }, number: 1, castShadow: true });
    const row = panel.getByTestId(`scene-director-light-${light!.id}`);
    // The new light is selected and its fields open under the row; the shadow switch stays on the row itself.
    await row.getByRole('switch', { name: 'Cast shadow', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id))[0]?.castShadow).toBe(false);
    await row.getByRole('button').first().click();
    await visibleSpace(page).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id)).length).toBe(0);
    await expect(panel).toContainText('No lights yet. The scene uses default lighting.');
  } finally {
    await deleteSpace(page, id);
  }
});

test('a second account sees the cameras and lights another member sets up', async ({ page, browser, baseURL }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const id = await createSpace(page, '3d', `director-shared-${Date.now()}`);
  const invitee = await browser.newContext({ baseURL, storageState: stateFile('B') });
  let inviteeId: string | undefined;
  try {
    inviteeId = (await dataOf<{ id: string }>(await invitee.request.get('/api/v1/auth/me'), 'invitee identity')).id;
    await openDirector(page);
    const panel = page.getByTestId('scene-director-panel');
    await panel.getByRole('button', { name: 'Save this view as a camera', exact: true }).click();
    await panel.getByRole('button', { name: 'Add light', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Point light', exact: true }).click();
    await expect.poll(async () => (await directorRecords(page, id)).length).toBe(2);
    const records = await directorRecords(page, id);

    const peer = await inviteMember(page, invitee, projectId, credentialsFor('B').email, 'editor');
    await peer.goto(smokeProjectUrl());
    await peer.getByTestId('space-drawer-trigger').click();
    await peer.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(peer.getByTestId('space-drawer')).toHaveCount(0);
    await visibleSpace(peer).getByTestId('scene-director-trigger').click();
    const peerPanel = peer.getByTestId('scene-director-panel');
    for (const record of records) {
      const testId = record.model.kind === 'camera' ? `scene-director-camera-${record.id}` : `scene-director-light-${record.id}`;
      await expect(peerPanel.getByTestId(testId)).toBeVisible();
    }
  } finally {
    try {
      await invitee.close();
    } finally {
      try {
        if (inviteeId) await cleanMembership(page, projectId, inviteeId);
      } finally {
        await deleteSpace(page, id);
      }
    }
  }
});
