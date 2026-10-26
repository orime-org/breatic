// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Page, type WebSocketRoute } from 'playwright/test';
import { createDecoder, readVarString } from 'lib0/decoding';
import { threeDSpaceDocName } from '@breatic/shared';
import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { liveModuleUrl } from '../helpers/live-module';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type * as SceneSessionModule from '../../src/data/yjs/scene-session';

/** Read actual renderer transforms after its asynchronous models have attached. */
async function renderedObjects(page: Page): Promise<Array<{ id: string; position: number[] }>> {
  return JSON.parse(await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-objects') ?? '[]') as Array<{ id: string; position: number[] }>;
}

/** Submit a complete position through the real inspector. */
async function setX(page: Page, value: number): Promise<void> {
  const input = page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Position (m)', exact: true }).getByLabel('X', { exact: true });
  await input.fill(String(value));
  await input.press('Tab');
}

/** Read the session's committed transform through the copy already loaded by the app. */
async function committedX(page: Page, spaceId: string): Promise<number> {
  const managerAt = await liveModuleUrl(page, 'data/yjs/manager.ts');
  const sceneAt = await liveModuleUrl(page, 'data/yjs/scene-session.ts');
  return page.evaluate(async ({ managerAt, sceneAt, projectId, spaceId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as typeof ManagerModule;
    const scene = await import(/* @vite-ignore */ sceneAt) as typeof SceneSessionModule;
    const name = manager.docName.threeDSpace(projectId, spaceId);
    const session = scene.peekSceneSession(name);
    if (!session || session.getSnapshot().status !== 'ready') throw new Error('The displayed scene has no live ready session.');
    return session.getSnapshot().objects[0].position[0];
  }, { managerAt, sceneAt, projectId: smokeProjectId(), spaceId });
}

test('3D Space creates, edits independent copies, locks, undoes and reopens its scene', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-edit-${Date.now()}`);
  try {
    const scene = visibleSpace(page);
    await scene.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(1);
    const originalId = (await renderedObjects(page))[0].id;
    await setX(page, 3.5);
    await expect.poll(async () => (await renderedObjects(page))[0]?.position[0]).toBe(3.5);
    await scene.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(2);
    const copyId = (await renderedObjects(page)).find((object) => object.id !== originalId)!.id;
    await setX(page, 8);
    await expect.poll(async () => (await renderedObjects(page)).find((object) => object.id === originalId)?.position[0]).toBe(3.5);
    await scene.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).find((object) => object.id === copyId)?.position[0]).toBe(4.5);
    await scene.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).find((object) => object.id === copyId)?.position[0]).toBe(8);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(scene.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await expect(scene.getByRole('button', { name: 'Duplicate', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await scene.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(1);
    await expect(scene.getByTestId('scene-recovery-status')).toHaveCount(0);
    await page.reload();
    await expect.poll(async () => (await renderedObjects(page))[0]?.position[0]).toBe(3.5);
    await scene.getByTestId('scene-objects-trigger').click();
    await page.getByTestId('scene-objects-panel').getByTestId(`scene-object-${originalId}`).click();
    await setX(page, 6);
    await expect(scene.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await page.getByTestId(`space-tab-${id}`).hover();
    await page.getByTestId(`space-tab-close-${id}`).click();
    await expect(page.getByTestId(`space-tab-${id}`)).toHaveCount(0);
    await page.getByTestId('space-drawer-trigger').click();
    await page.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(page.getByTestId('space-drawer')).toHaveCount(0);
    await expect.poll(async () => (await renderedObjects(page))[0]?.position[0]).toBe(6);
    await expect(scene.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(scene.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
    await expect(scene.getByTestId('scene-object-menu')).toHaveCount(0);
  } finally {
    await deleteSpace(page, id);
  }
});

test('two 3D connections merge offline attributes and preserve peer transforms through personal undo', async ({ page, browser, baseURL }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-collab-${Date.now()}`);
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('A') });
  const peer = await peerContext.newPage();
  try {
    await visibleSpace(page).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(1);
    const objectId = (await renderedObjects(page))[0].id;
    await peer.goto(smokeProjectUrl());
    // Both tabs explicitly open the same Space; opening a Space elsewhere does not open it locally.
    await peer.getByTestId('space-drawer-trigger').click();
    await peer.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(peer.getByTestId('space-drawer')).toHaveCount(0);
    await expect.poll(async () => (await renderedObjects(peer)).length).toBe(1);
    await visibleSpace(peer).getByTestId('scene-objects-trigger').click();
    await peer.getByTestId(`scene-object-${objectId}`).click();
    await page.context().setOffline(true);
    await setX(page, 5);
    const peerName = peer.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true });
    await peerName.fill('Peer figure'); await peerName.press('Tab');
    await page.context().setOffline(false);
    await expect.poll(() => committedX(peer, id)).toBe(5);
    await expect(page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true })).toHaveValue('Peer figure');
    await page.context().setOffline(true); await peerContext.setOffline(true);
    await setX(page, 7); await setX(peer, 8);
    await peerContext.setOffline(false); await page.context().setOffline(false);
    await expect.poll(async () => {
      const a = await committedX(page, id); const b = await committedX(peer, id);
      return { same: a === b, valid: [7, 8].includes(a) };
    }).toEqual({ same: true, valid: true });
    expect([7, 8]).toContain(await committedX(page, id));
    await visibleSpace(page).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => committedX(peer, id)).toBe(8);
    await visibleSpace(peer).getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => committedX(page, id)).toBe(5);
  } finally {
    await page.context().setOffline(false);
    await peerContext.close();
    await deleteSpace(page, id);
  }
});

test('a new 3D document stays read-only until its first real sync and then accepts shared edits', async ({ page, browser, baseURL }) => {
  let pausedName: string | null = null;
  const held: Array<{ route: WebSocketRoute; message: Buffer }> = [];
  await page.routeWebSocket((url) => url.pathname === '/ws', (route) => {
    const server = route.connectToServer();
    server.onMessage((message) => {
      // Delay only the target document's real server bytes; meta and all
      // client-to-server traffic still use their original live connection.
      if (typeof message !== 'string' && pausedName !== null
        && readVarString(createDecoder(message)) === pausedName) {
        held.push({ route, message });
        return;
      }
      route.send(message);
    });
  });
  await openSmokeProject(page);
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('A') });
  const peer = await peerContext.newPage();
  let id: string | undefined;
  try {
    await openSmokeProject(peer);
    id = await createSpace(peer, '3d', `scene-first-sync-${Date.now()}`);
    await expect(visibleSpace(peer).getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    pausedName = threeDSpaceDocName(smokeProjectId(), id);
    await page.getByTestId('space-drawer-trigger').click();
    await page.getByTestId(`space-drawer-row-${id}`).getByRole('button').first().click();
    await expect(page.getByTestId('space-drawer')).toHaveCount(0);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    const scene = visibleSpace(page);
    await expect(scene.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await expect(scene.getByTestId('three-d-viewport')).toHaveCount(0);
    await expect(page.getByTestId('workspace-disabled-overlay')).toHaveCount(0);

    pausedName = null;
    for (const { route, message } of held.splice(0)) route.send(message);
    await expect(scene.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
    await scene.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(1);
    await expect.poll(async () => (await renderedObjects(peer)).length).toBe(1);
  } finally {
    pausedName = null;
    for (const { route, message } of held.splice(0)) route.send(message);
    await peerContext.close();
    if (id) await deleteSpace(page, id);
  }
});
