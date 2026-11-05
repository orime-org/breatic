// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page, type Route } from 'playwright/test';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { httpRequest } from '@breatic/shared';
import type { SceneObject, UploadStatus } from '@breatic/shared';
import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { credentialsFor } from '../helpers/credentials';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { liveModuleUrl } from '../helpers/live-module';
import { roomForUploads, watchUploadTickets } from '../helpers/upload-budget';
import { dataOf } from '../helpers/api';
import { incompleteScene, incompleteSceneZip, sceneFiles, sceneGlb, sceneZip } from '../helpers/scene-model';
import type { SceneModelInput } from '../helpers/scene-model';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type * as SessionModule from '../../src/data/yjs/scene-session';
import type { SceneView } from '../../src/spaces/three-d/viewport/scene-viewport-props';

/**
 * Read committed content from the application's already-loaded document owner.
 * @param page - A page displaying the tested Project.
 * @param spaceId - This case's scene document identity.
 * @returns Actual validated scene objects.
 * @throws {Error} When the real scene session is absent or not ready.
 */
async function sceneObjects(page: Page, spaceId: string): Promise<readonly SceneObject[]> {
  const managerAt = await liveModuleUrl(page, 'data/yjs/manager.ts');
  const sessionAt = await liveModuleUrl(page, 'data/yjs/scene-session.ts');
  return page.evaluate(async ({ managerAt, sessionAt, projectId, spaceId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as typeof ManagerModule;
    const sessions = await import(/* @vite-ignore */ sessionAt) as typeof SessionModule;
    const session = sessions.peekSceneSession(manager.docName.threeDSpace(projectId, spaceId));
    if (!session || session.getSnapshot().status !== 'ready') throw new Error('Expected the actual ready scene session');
    return session.getSnapshot().objects;
  }, { managerAt, sessionAt, projectId: smokeProjectId(), spaceId });
}

/**
 * Read only objects whose actual Three instances have finished loading.
 * @param page - The active scene page.
 * @returns Rendered object identities and positions.
 * @throws {Error} When the viewport inspection data cannot be read.
 */
async function renderedObjects(page: Page): Promise<Array<{ id: string; position: number[] }>> {
  const data = await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-objects');
  return JSON.parse(data ?? '[]') as Array<{ id: string; position: number[] }>;
}

/**
 * Read the active renderer's local camera without consulting shared content.
 * @param page - A page displaying its own scene camera.
 * @returns Actual personal camera position and orbit target.
 * @throws {Error} When the runtime has no camera inspection data.
 */
async function sceneView(page: Page): Promise<SceneView> {
  const value = await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-view');
  if (value === null) throw new Error('Expected the real scene camera');
  return JSON.parse(value) as SceneView;
}

/**
 * Open the import through the keyboard-operated Add menu and its focus handoff.
 * @param page - The active editable scene page.
 * @returns The visible model import dialog.
 * @throws {Error} When the scene or dialog cannot be opened.
 */
async function openImport(page: Page): Promise<Locator> {
  const add = visibleSpace(page).getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeEnabled();
  await add.press('Enter');
  await page.getByRole('menuitem', { name: 'Import model', exact: true }).press('Enter');
  const dialog = page.getByTestId('model-import-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Require a drawn preview and a live WebGL context after React commits its view.
 * @param dialog - The actual model import dialog.
 * @throws {Error} When preview construction or drawing fails.
 */
async function previewReady(dialog: Locator): Promise<void> {
  const canvas = dialog.getByTestId('model-import-preview').locator('canvas');
  await expect(canvas).toBeVisible();
  await canvas.evaluate(async (element: HTMLCanvasElement) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const context = element.getContext('webgl2');
    if (!context || context.isContextLost() || context.getError() !== context.NO_ERROR) throw new Error('Expected the live rendered model preview');
  });
  await expect(dialog.getByText('The model preview could not be displayed.', { exact: true })).toHaveCount(0);
}

/**
 * Register an actual model and wait for the resulting collaborative object.
 * @param page - The active editable scene page.
 * @param file - Original browser input, independently generated by the fixture helper.
 * @param name - Exact object name entered by the user.
 * @param entry - Explicit main file when an archive contains several models.
 * @returns The real upload authorization answer.
 * @throws {Error} When checking, uploading or registration fails.
 */
async function importModel(page: Page, file: SceneModelInput, name: string, entry?: string): Promise<Record<string, unknown>> {
  const dialog = await openImport(page);
  await dialog.locator('input[type="file"]').first().setInputFiles(file);
  if (entry !== undefined) {
    await expect(dialog.getByText('Choose a main file to preview.', { exact: true })).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Main file', exact: true }).click();
    await page.getByRole('option', { name: entry, exact: true }).click();
  }
  await previewReady(dialog);
  await dialog.getByRole('textbox', { name: 'Model name', exact: true }).fill(name);
  await roomForUploads(1);
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
    && response.request().method() === 'POST', { timeout: test.info().timeout });
  await dialog.getByRole('button', { name: 'Import to scene', exact: true }).click();
  const ticket = await dataOf<Record<string, unknown>>(await answer, 'authorize an actual model upload');
  await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
  await expect(page.getByText('Model imported.', { exact: true })).toBeVisible();
  return ticket;
}

/**
 * Pause one authoritative completion while preserving the actual backend request.
 * @param page - The account waiting for its model registration.
 * @param key - The storage key returned by its real upload ticket.
 * @param onCompleted - Receives the actual registered asset identity.
 * @param released - Resolves when the case allows the original response through.
 * @returns Removal of this case's interception handler.
 * @throws {Error} When the actual status request or response cannot be handled.
 */
async function holdRegistration(page: Page, key: Promise<string>, onCompleted: (assetId: string) => void, released: Promise<void>): Promise<() => Promise<void>> {
  const pattern = '**/api/v1/assets/upload-status**';
  let held = false;
  const handling = new Set<Promise<void>>();
  /**
   * Hold only this operation's first real completed status.
   * @param route - Original browser status request.
   * @throws {Error} When the backend request cannot be proxied.
   */
  const capture = async (route: Route): Promise<void> => {
    const finished = Promise.withResolvers<void>();
    handling.add(finished.promise);
    try {
      const response = await route.fetch();
      if (response.status() === 200) {
        const body = await response.json() as { data: { items: UploadStatus[] } };
        const storageKey = await key;
        const result = body.data.items.find((item) => item.key === storageKey && item.state === 'completed');
        if (!held && result?.state === 'completed') {
          held = true;
          onCompleted(result.result.assetId);
          await released;
        }
      }
      await route.fulfill({ response });
    } finally {
      handling.delete(finished.promise);
      finished.resolve();
    }
  };
  await page.route(pattern, capture);
  return async (): Promise<void> => {
    await Promise.all([...handling]);
    await page.unroute(pattern, capture);
  };
}

/**
 * End a Space tab through the actual Project tab strip.
 * @param page - A Project page with the target scene open.
 * @param spaceId - This case's scene tab.
 * @throws {Error} When the tab cannot be closed.
 */
async function closeSceneTab(page: Page, spaceId: string): Promise<void> {
  const tab = page.getByTestId(`space-tab-${spaceId}`);
  await tab.hover();
  await page.getByTestId(`space-tab-close-${spaceId}`).click();
  await expect(tab).toHaveCount(0);
}

/**
 * Reopen an existing scene from the actual Space drawer.
 * @param page - The Project retaining this scene.
 * @param spaceId - Scene identity preserved by the server.
 * @throws {Error} When the drawer cannot open the scene.
 */
async function reopenScene(page: Page, spaceId: string): Promise<void> {
  await page.getByTestId('space-drawer-trigger').click();
  await page.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button').first().click();
  await expect(page.getByTestId('space-drawer')).toHaveCount(0);
  await expect(visibleSpace(page).getByTestId('three-d-viewport')).toBeVisible();
}

/**
 * Commit a selected object's position through its real property field.
 * @param page - Scene whose imported object is currently selected.
 * @param value - New X coordinate in metres.
 * @throws {Error} When the inspector cannot accept the command.
 */
async function setX(page: Page, value: number): Promise<void> {
  const input = page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Position (m)', exact: true }).getByLabel('X', { exact: true });
  await input.fill(String(value));
  await input.press('Enter');
}

test('model import checks original dependencies and retains a prepared model across hiding', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Model preflight ${crypto.randomUUID()}`);
  try {
    const dialog = await openImport(page);
    await dialog.locator('input[type="file"]').first().setInputFiles(incompleteScene());
    await expect(dialog.getByText('Add the missing accompanying files.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('mesh.bin', { exact: true })).toBeVisible();
    await expect(dialog.getByText('color.png', { exact: true })).toBeVisible();
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Add accompanying files', exact: true }).click();
    await (await chooserPromise).setFiles(sceneFiles('supplement').slice(1));
    await previewReady(dialog);
    const name = dialog.getByRole('textbox', { name: 'Model name', exact: true });
    await name.fill('Prepared character');
    await expect(dialog.getByRole('button', { name: 'Import to scene', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const reopened = await openImport(page);
    await expect(reopened.getByRole('textbox', { name: 'Model name', exact: true })).toHaveValue('Prepared character');
    await previewReady(reopened);
    await page.keyboard.press('Escape');
    await expect(reopened).toHaveCount(0);
    await expect(visibleSpace(page).getByRole('button', { name: 'Add', exact: true })).toBeFocused();
    expect(await sceneObjects(page, id)).toEqual([]);
  } finally {
    await deleteSpace(page, id);
  }
});

test('a ZIP missing resources inside its folder is completed with accompanying files', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Model zip supplement ${crypto.randomUUID()}`);
  try {
    const dialog = await openImport(page);
    await dialog.locator('input[type="file"]').first().setInputFiles(incompleteSceneZip());
    await expect(dialog.getByText('models/mesh.bin', { exact: true })).toBeVisible();
    await expect(dialog.getByText('models/color.png', { exact: true })).toBeVisible();
    const chooserPromise = page.waitForEvent('filechooser');
    await dialog.getByRole('button', { name: 'Add accompanying files', exact: true }).click();
    await (await chooserPromise).setFiles(sceneFiles('zip-supplement').slice(1));
    await previewReady(dialog);
    await expect(dialog.getByRole('button', { name: 'Import to scene', exact: true })).toBeEnabled();
    expect(await sceneObjects(page, id)).toEqual([]);
  } finally {
    await deleteSpace(page, id);
  }
});

test('a textured GLB is registered once, independently edited, undone and reopened @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Imported GLB ${crypto.randomUUID()}`);
  try {
    const file = sceneGlb(crypto.randomUUID());
    const first = await importModel(page, file, 'First imported character');
    expect(first.alreadyExists).not.toBe(true);
    expect(first).not.toHaveProperty('taskId');
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
    const original = (await sceneObjects(page, id))[0];
    if (original.model.kind !== 'asset') throw new Error('Expected a registered model reference');
    const assetId = original.model.assetId;
    const asset = await dataOf<{ mimeType: string; sizeBytes: number }>(
      await page.request.get(`/api/v1/projects/${smokeProjectId()}/three-d/assets/${assetId}`), 'resolve the registered model',
    );
    expect(asset).toMatchObject({ mimeType: 'model/gltf-binary', sizeBytes: file.buffer.byteLength });
    const repeated = await importModel(page, file, 'Second imported character');
    expect(repeated).toMatchObject({ alreadyExists: true, assetId });
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(2);
    const objects = await sceneObjects(page, id);
    expect(objects.map((object) => object.model)).toEqual([{ kind: 'asset', assetId }, { kind: 'asset', assetId }]);
    expect(objects.map((object) => object.id)[0]).not.toBe(objects.map((object) => object.id)[1]);
    await setX(page, 4);
    const secondId = (await sceneObjects(page, id)).find((object) => object.name === 'Second imported character')!.id;
    const editor = visibleSpace(page);
    await editor.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(3);
    await setX(page, 8);
    expect((await sceneObjects(page, id)).find((object) => object.id === secondId)?.position[0]).toBe(4);
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Position (m)', exact: true }).getByLabel('X', { exact: true })).toHaveValue('5');
    await editor.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Move', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await editor.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(2);
    await page.reload();
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(2);
    expect((await sceneObjects(page, id)).map((object) => object.model)).toEqual([{ kind: 'asset', assetId }, { kind: 'asset', assetId }]);
    await closeSceneTab(page, id);
    await reopenScene(page, id);
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(2);
  } finally {
    await deleteSpace(page, id);
  }
});

test('a selected ZIP entry preserves original resources through registration and reload @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Imported ZIP ${crypto.randomUUID()}`);
  try {
    const file = sceneZip(crypto.randomUUID(), true);
    await importModel(page, file, 'Selected ZIP character', 'models/second.gltf');
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
    const object = (await sceneObjects(page, id))[0];
    object.position.forEach((value, axis) => expect(value).toBeCloseTo([-1, 0, 0][axis], 12));
    if (object.model.kind !== 'asset') throw new Error('Expected a registered ZIP model');
    const asset = await dataOf<{ url: string; mimeType: string; sizeBytes: number }>(
      await page.request.get(`/api/v1/projects/${smokeProjectId()}/three-d/assets/${object.model.assetId}`), 'resolve the registered model package',
    );
    expect(asset.mimeType).toBe('application/zip');
    const response = await httpRequest(asset.url, { method: 'GET' }, { replaySafe: true });
    expect(response.status).toBe(200);
    const storedBytes = new Uint8Array(await response.arrayBuffer());
    expect(asset.sizeBytes).toBe(storedBytes.byteLength);
    const original = unzipSync(Uint8Array.from(file.buffer));
    const stored = unzipSync(storedBytes);
    expect(JSON.parse(strFromU8(stored['manifest.json']))).toEqual({ formatVersion: 1, entryPath: 'files/models/second.gltf' });
    expect(Object.keys(stored).sort()).toEqual(['manifest.json', ...Object.keys(original).map((path) => `files/${path}`)].sort());
    for (const [path, bytes] of Object.entries(original)) expect(Array.from(stored[`files/${path}`])).toEqual(Array.from(bytes));
    await page.reload();
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
    expect(await sceneObjects(page, id)).toMatchObject([{ id: object.id, name: 'Selected ZIP character', model: object.model }]);
    await visibleSpace(page).getByTestId('three-d-viewport').press('f');
    await expect.poll(async () => (await sceneView(page)).target).toEqual([0, 0.5, 0]);
  } finally {
    await deleteSpace(page, id);
  }
});

for (const role of ['editor', 'viewer'] as const) {
  test(`a different account reads an imported ZIP as ${role} with Project and Studio isolation @needs-storage @needs-ingest`, async ({ page, browser, baseURL }) => {
    const peerContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
    let id: string | undefined;
    let peerId: string | undefined;
    const projectId = smokeProjectId();
    try {
      await openSmokeProject(page);
      id = await createSpace(page, '3d', `Shared imported model ${crypto.randomUUID()}`);
      await importModel(page, sceneZip(crypto.randomUUID()), 'Shared ZIP model');
      await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
      const original = (await sceneObjects(page, id))[0];
      if (original.model.kind !== 'asset') throw new Error('Expected the shared registered model');
      const assetId = original.model.assetId;
      const owner = await dataOf<{ id: string }>(await page.request.get('/api/v1/auth/me'), 'read owner identity');
      const other = await dataOf<{ id: string }>(await peerContext.request.get('/api/v1/auth/me'), 'read collaborator identity');
      peerId = other.id;
      expect(peerId).not.toBe(owner.id);
      const peer = await inviteMember(page, peerContext, projectId, credentialsFor('B').email, role);
      await peer.goto(smokeProjectUrl());
      await reopenScene(peer, id);
      await expect.poll(async () => (await renderedObjects(peer)).length, { timeout: test.info().timeout }).toBe(1);
      expect(await sceneObjects(peer, id)).toEqual(await sceneObjects(page, id));
      const asset = await dataOf<{ url: string; mimeType: string; sizeBytes: number }>(
        await peerContext.request.get(`/api/v1/projects/${projectId}/three-d/assets/${assetId}`), 'read the shared Studio asset',
      );
      expect(asset.mimeType).toBe('application/zip');
      const foreign = await peerContext.request.get(`/api/v1/projects/${smokeProjectId('B')}/three-d/assets/${assetId}`);
      expect(foreign.status()).toBe(404);
      const peerView = await sceneView(peer);
      const ownerName = page.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true });
      if (role === 'editor') {
        await visibleSpace(peer).getByTestId('scene-objects-trigger').click();
        await peer.getByTestId(`scene-object-${original.id}`).click();
        const name = peer.getByTestId('scene-properties-panel').getByLabel('Name', { exact: true });
        await name.fill('Collaborator model name');
        await name.press('Enter');
        await expect(ownerName).toHaveValue('Collaborator model name');
        await setX(page, 4);
        await expect.poll(async () => (await renderedObjects(peer))[0].position[0]).toBe(4);
        await visibleSpace(page).getByRole('button', { name: 'Undo', exact: true }).click();
        await expect.poll(async () => (await renderedObjects(peer))[0].position[0]).toBe(original.position[0]);
        await expect(name).toHaveValue('Collaborator model name');
      } else {
        await expect(visibleSpace(peer).getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
        const stored = await httpRequest(asset.url, { method: 'GET' }, { replaySafe: true });
        expect(stored.status).toBe(200);
        const bytes = new Uint8Array(await stored.arrayBuffer());
        const refused = await peerContext.request.post('/api/v1/assets/upload-ticket', { data: {
          project_id: projectId, purpose: 'scene_model', filename: 'shared-model.zip', content_type: 'application/zip',
          size: bytes.byteLength, client_hash: createHash('sha256').update(bytes).digest('hex'),
        } });
        expect(refused.status()).toBe(403);
      }
      await ownerName.fill('Owner model update');
      await ownerName.press('Enter');
      await expect.poll(async () => (await sceneObjects(peer, id!))[0].name).toBe('Owner model update');
      const afterView = await sceneView(peer);
      expect(afterView.target).toEqual(peerView.target);
      peerView.position.forEach((value, axis) => expect(afterView.position[axis]).toBeCloseTo(value, 12));
    } finally {
      try {
        await peerContext.close();
      } finally {
        try {
          if (peerId) await cleanMembership(page, projectId, peerId);
        } finally {
          if (id) await deleteSpace(page, id);
        }
      }
    }
  });
}

for (const [codec, label] of [['draco', 'Draco'], ['meshopt', 'EXT Meshopt'], ['ktx2', 'KTX2']] as const) {
  test(`model import uses the shipped ${label} decoder for a real preview`, async ({ page }) => {
    const colourWarnings: string[] = [];
    page.on('console', (message) => {
      if (message.text().startsWith('THREE.Color:')) colourWarnings.push(message.text());
    });
    await openSmokeProject(page);
    const id = await createSpace(page, '3d', `Compressed preview ${codec} ${crypto.randomUUID()}`);
    try {
      const dialog = await openImport(page);
      const directory = 'tests/fixtures/three-d-model-import';
      await dialog.locator('input[type="file"]').first().setInputFiles([
        `${directory}/${codec}.gltf`, ...(codec === 'ktx2' ? [`${directory}/normal.ktx2`] : []),
      ]);
      const failure = dialog.locator('p.text-status-error');
      await Promise.race([
        dialog.getByText('Model and accompanying files are ready', { exact: true }).waitFor({ state: 'visible', timeout: test.info().timeout }),
        failure.waitFor({ state: 'visible', timeout: test.info().timeout }).then(async () => { throw new Error(await failure.innerText()); }),
      ]);
      await previewReady(dialog);
      await expect(dialog.getByRole('button', { name: 'Import to scene', exact: true })).toBeEnabled();
      expect(await sceneObjects(page, id)).toEqual([]);
      expect(colourWarnings).toEqual([]);
    } finally {
      await deleteSpace(page, id);
    }
  });
}

test('a registered model whose decoder download fails offers Retry and loads once the download succeeds @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Decoder retry ${crypto.randomUUID()}`);
  /**
   * Fail only the decoder binary download; the module exporting its URL still loads.
   * @param url - A requested URL.
   * @returns Whether the request is the Draco decoder binary.
   */
  const decoder = (url: URL): boolean => url.pathname.endsWith('draco_decoder.wasm') && !url.search.includes('import');
  try {
    await importModel(page, { name: 'draco.gltf', mimeType: 'model/gltf+json', buffer: readFileSync('tests/fixtures/three-d-model-import/draco.gltf') }, 'Compressed character');
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
    await page.route(decoder, (route) => route.abort('internetdisconnected'));
    await page.reload();
    const banner = visibleSpace(page).getByText('A model could not be loaded.', { exact: true });
    await expect(banner).toBeVisible({ timeout: test.info().timeout });
    await expect(visibleSpace(page).getByText('The model or an accompanying file could not be read.', { exact: true })).toHaveCount(0);
    await page.unroute(decoder);
    await visibleSpace(page).getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(banner).toHaveCount(0, { timeout: test.info().timeout });
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
  } finally {
    await page.unrouteAll();
    await deleteSpace(page, id);
  }
});

test('closing an import during registration preserves its Studio asset without writing a reopened scene @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const otherId = await page.getByRole('tab').first().getAttribute('data-space-tab');
  if (!otherId) throw new Error('Expected the Project initial Space');
  const id = await createSpace(page, '3d', `Closed import ${crypto.randomUUID()}`);
  const completed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const keyReady = Promise.withResolvers<string>();
  let assetId: string | undefined;
  const stopHolding = await holdRegistration(page, keyReady.promise, (registeredId) => {
    assetId = registeredId;
    completed.resolve();
  }, release.promise);
  try {
    const file = sceneGlb(crypto.randomUUID());
    const dialog = await openImport(page);
    await dialog.locator('input[type="file"]').first().setInputFiles(file);
    await previewReady(dialog);
    await roomForUploads(1);
    const ticketResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await dialog.getByRole('button', { name: 'Import to scene', exact: true }).click();
    const ticket = await dataOf<Record<string, unknown>>(await ticketResponse, 'open the actual retained model upload');
    if (typeof ticket.storageKey !== 'string') throw new Error('Expected a new opened model upload');
    keyReady.resolve(ticket.storageKey);
    await completed.promise;
    await expect(dialog.getByText('Registering model…', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId(`space-tab-${otherId}`).click();
    await expect(page.getByTestId(`space-tab-${otherId}`)).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId(`space-tab-${id}`).click();
    await visibleSpace(page).getByRole('button', { name: 'Registering model…', exact: true }).click();
    await expect(dialog.getByText('Registering model…', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await closeSceneTab(page, id);
    await reopenScene(page, id);
    const reopened = await openImport(page);
    await expect(reopened.getByTestId('model-import-dropzone')).toBeVisible();
    const lateResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-status');
    release.resolve();
    await (await lateResponse).finished();
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(reopened.getByTestId('model-import-dropzone')).toBeVisible();
    expect(await sceneObjects(page, id)).toEqual([]);
    expect(typeof assetId).toBe('string');
    const asset = await dataOf<{ mimeType: string; sizeBytes: number }>(
      await page.request.get(`/api/v1/projects/${smokeProjectId()}/three-d/assets/${assetId}`), 'read the completed original Studio asset',
    );
    expect(asset).toMatchObject({ mimeType: 'model/gltf-binary', sizeBytes: file.buffer.byteLength });
  } finally {
    try {
      await page.keyboard.press('Escape');
      if (await page.getByTestId(`space-tab-${id}`).count()) await closeSceneTab(page, id);
    } finally {
      keyReady.resolve('');
      release.resolve();
      await stopHolding();
      await deleteSpace(page, id);
    }
  }
});

test('failed model transfer and loading retain existing objects and retry the same input @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Retried model ${crypto.randomUUID()}`);
  const partsPattern = '**/uploads/**/parts/*';
  const assetsPattern = '**/api/v1/projects/**/three-d/assets/**';
  let failTransfer = true;
  let failResolve = true;
  await page.route(partsPattern, async (route) => {
    if (failTransfer && route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  await page.route(assetsPattern, async (route) => {
    if (failResolve) {
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  try {
    const editor = visibleSpace(page);
    await editor.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add block', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(1);
    const original = (await sceneObjects(page, id))[0];
    const dialog = await openImport(page);
    await dialog.locator('input[type="file"]').first().setInputFiles(sceneGlb(crypto.randomUUID()));
    await previewReady(dialog);
    const name = dialog.getByRole('textbox', { name: 'Model name', exact: true });
    await name.fill('Retried character');
    await roomForUploads(1);
    await dialog.getByRole('button', { name: 'Import to scene', exact: true }).click();
    const transferFailure = dialog.locator('p.text-status-error');
    await expect(transferFailure).toBeVisible({ timeout: test.info().timeout });
    expect(await transferFailure.innerText()).toBe('The model could not be uploaded. Try again.');
    await expect(name).toHaveValue('Retried character');
    await previewReady(dialog);
    expect(await sceneObjects(page, id)).toEqual([original]);
    failTransfer = false;
    await roomForUploads(1);
    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
    await expect(editor.getByText('A model could not be loaded.', { exact: true })).toBeVisible({ timeout: test.info().timeout });
    expect((await sceneObjects(page, id)).find((object) => object.id === original.id)).toEqual(original);
    expect((await sceneObjects(page, id)).filter((object) => object.name === 'Retried character')).toHaveLength(1);
    failResolve = false;
    await editor.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(2);
    expect((await sceneObjects(page, id)).find((object) => object.id === original.id)).toEqual(original);
  } finally {
    failTransfer = false;
    failResolve = false;
    await page.unroute(partsPattern);
    await page.unroute(assetsPattern);
    await deleteSpace(page, id);
  }
});

test('registration retains an asset across live permission loss and places it once after editing returns @needs-storage @needs-ingest', async ({ page, browser, baseURL }) => {
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
  const projectId = smokeProjectId();
  const keyReady = Promise.withResolvers<string>();
  const completed = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  let id: string | undefined;
  let peerId: string | undefined;
  let peer: Page | undefined;
  let stopHolding: (() => Promise<void>) | undefined;
  try {
    await openSmokeProject(page);
    id = await createSpace(page, '3d', `Permission-bound model ${crypto.randomUUID()}`);
    peerId = (await dataOf<{ id: string }>(await peerContext.request.get('/api/v1/auth/me'), 'read uploading account identity')).id;
    peer = await inviteMember(page, peerContext, projectId, credentialsFor('B').email, 'editor');
    watchUploadTickets(peer, 'B');
    let tickets = 0;
    peer.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/assets/upload-ticket'
        && (request.postDataJSON() as { purpose?: string }).purpose === 'scene_model') tickets += 1;
    });
    await peer.goto(smokeProjectUrl());
    await reopenScene(peer, id);
    stopHolding = await holdRegistration(peer, keyReady.promise, completed.resolve, release.promise);
    const dialog = await openImport(peer);
    await dialog.locator('input[type="file"]').first().setInputFiles(sceneGlb(crypto.randomUUID()));
    await previewReady(dialog);
    await dialog.getByRole('textbox', { name: 'Model name', exact: true }).fill('Permission-bound character');
    await roomForUploads(1, 'B');
    const ticketResponse = peer.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await dialog.getByRole('button', { name: 'Import to scene', exact: true }).click();
    const ticket = await dataOf<Record<string, unknown>>(await ticketResponse, 'open the collaborator model upload');
    if (typeof ticket.storageKey !== 'string') throw new Error('Expected a newly opened collaborator upload');
    keyReady.resolve(ticket.storageKey);
    const assetId = await completed.promise;
    await dataOf(await page.request.patch(`/api/v1/projects/${projectId}/members/${peerId}`, { data: { role: 'viewer' } }), 'revoke editing during registration');
    await expect(dialog.getByText('You can import a model once you have editing access.', { exact: true })).toBeVisible();
    const lateResponse = peer.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-status');
    release.resolve();
    await (await lateResponse).finished();
    await expect(dialog.getByText('The model is uploaded. You can place it once editing access returns.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import to scene', exact: true })).toBeDisabled();
    expect(await sceneObjects(peer, id)).toEqual([]);
    expect(await sceneObjects(page, id)).toEqual([]);
    await dataOf(await page.request.patch(`/api/v1/projects/${projectId}/members/${peerId}`, { data: { role: 'editor' } }), 'restore editing after registration');
    await expect(dialog.getByRole('button', { name: 'Import to scene', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Import to scene', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
    await expect.poll(async () => (await renderedObjects(peer!)).length, { timeout: test.info().timeout }).toBe(1);
    expect(await sceneObjects(page, id)).toMatchObject([{ name: 'Permission-bound character', model: { kind: 'asset', assetId } }]);
    expect(tickets).toBe(1);
  } finally {
    try {
      if (peer && id && !peer.isClosed() && await peer.getByTestId(`space-tab-${id}`).count()) {
        await peer.keyboard.press('Escape');
        await closeSceneTab(peer, id);
      }
    } finally {
      keyReady.resolve('');
      release.resolve();
      try {
        await stopHolding?.();
      } finally {
        try {
          await peerContext.close();
        } finally {
          try {
            if (peerId) await cleanMembership(page, projectId, peerId);
          } finally {
            if (id) await deleteSpace(page, id);
          }
        }
      }
    }
  }
});
