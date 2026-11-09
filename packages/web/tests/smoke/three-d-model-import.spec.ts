// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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
 * Open the import from the left rail by keyboard.
 * @param page - The active editable scene page.
 * @returns The visible model import dialog.
 * @throws {Error} When the scene or dialog cannot be opened.
 */
async function openImport(page: Page): Promise<Locator> {
  const button = visibleSpace(page).getByRole('button', { name: 'Import model', exact: true });
  await expect(button).toBeEnabled();
  await button.press('Enter');
  const dialog = page.getByTestId('model-import-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The visible Space's row for one task, on its task list.
 * @param page - The page.
 * @param taskId - The row.
 * @returns The row.
 */
function taskRow(page: Page, taskId: unknown): Locator {
  return visibleSpace(page).getByTestId(`scene-task-${String(taskId)}`);
}

/**
 * Open the visible Space's task list, if it is not open already.
 * @param page - The page.
 * @throws {Error} When the panel cannot be opened.
 */
async function openTasks(page: Page): Promise<void> {
  if (await visibleSpace(page).getByTestId('scene-tasks-panel').count()) return;
  await visibleSpace(page).getByTestId('scene-tasks-trigger').click();
  await expect(visibleSpace(page).getByTestId('scene-tasks-panel')).toBeVisible();
}

/**
 * Place a finished row's model into the scene from the task list.
 * @param page - The page.
 * @param taskId - The finished row.
 * @throws {Error} When the row does not finish or cannot place its model.
 */
async function placeFromTasks(page: Page, taskId: unknown): Promise<void> {
  await openTasks(page);
  const row = taskRow(page, taskId);
  const place = row.getByRole('button', { name: 'Place in scene', exact: true });
  await expect(place).toBeVisible({ timeout: test.info().timeout });
  await place.click();
  await expect(place).not.toHaveAttribute('aria-busy', 'true', { timeout: test.info().timeout });
  await expect(visibleSpace(page).getByTestId('scene-tasks-panel')).toBeVisible();
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
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  const ticket = await dataOf<Record<string, unknown>>(await answer, 'authorize an actual model upload');
  await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
  await expect(taskRow(page, ticket.taskId)).toBeVisible();
  await placeFromTasks(page, ticket.taskId);
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
 * Show the selection's properties; placing from the task list keeps the task list open.
 * @param page - Scene with a selection.
 * @throws {Error} When the properties panel cannot be shown.
 */
async function showProperties(page: Page): Promise<void> {
  if (await page.getByTestId('scene-properties-panel').count()) return;
  await visibleSpace(page).getByTestId('scene-properties-trigger').click();
  await expect(page.getByTestId('scene-properties-panel')).toBeVisible();
}

/**
 * Commit a selected object's position through its real property field.
 * @param page - Scene whose imported object is currently selected.
 * @param value - New X coordinate in metres.
 * @throws {Error} When the inspector cannot accept the command.
 */
async function setX(page: Page, value: number): Promise<void> {
  await showProperties(page);
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
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const reopened = await openImport(page);
    await expect(reopened.getByRole('textbox', { name: 'Model name', exact: true })).toHaveValue('Prepared character');
    await previewReady(reopened);
    await page.keyboard.press('Escape');
    await expect(reopened).toHaveCount(0);
    await expect(visibleSpace(page).getByRole('button', { name: 'Import model', exact: true })).toBeFocused();
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
    await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
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
    expect(typeof first.taskId).toBe('string');
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
    expect(repeated.taskId).not.toBe(first.taskId);
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
        await showProperties(page);
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
          project_id: projectId, purpose: 'scene_model', space_id: id, label: 'Shared model', filename: 'shared-model.zip', content_type: 'application/zip',
          size: bytes.byteLength, client_hash: createHash('sha256').update(bytes).digest('hex'),
        } });
        expect(refused.status()).toBe(403);
      }
      await showProperties(page);
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
      await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
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

test('a model registered while its tab is closed is listed done on reopen and placed from the list @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Closed import ${crypto.randomUUID()}`);
  const completed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const keyReady = Promise.withResolvers<string>();
  const stopHolding = await holdRegistration(page, keyReady.promise, () => completed.resolve(), release.promise);
  try {
    const file = sceneGlb(crypto.randomUUID());
    const dialog = await openImport(page);
    await dialog.locator('input[type="file"]').first().setInputFiles(file);
    await previewReady(dialog);
    await dialog.getByRole('textbox', { name: 'Model name', exact: true }).fill('Closed character');
    await roomForUploads(1);
    const ticketResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    const ticket = await dataOf<Record<string, unknown>>(await ticketResponse, 'open the actual model upload');
    if (typeof ticket.storageKey !== 'string') throw new Error('Expected a new opened model upload');
    keyReady.resolve(ticket.storageKey);
    await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
    await completed.promise;
    await expect(taskRow(page, ticket.taskId)).toContainText('Closed character');
    await closeSceneTab(page, id);
    release.resolve();
    await reopenScene(page, id);
    await openTasks(page);
    await expect(taskRow(page, ticket.taskId)).toContainText('Done', { timeout: test.info().timeout });
    expect(await sceneObjects(page, id)).toEqual([]);
    await placeFromTasks(page, ticket.taskId);
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(1);
    expect(await sceneObjects(page, id)).toMatchObject([{ name: 'Closed character' }]);
  } finally {
    keyReady.resolve('');
    release.resolve();
    await stopHolding();
    await deleteSpace(page, id);
  }
});

test('closing the Space tab is held back while a model\'s bytes are being sent @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `Held import ${crypto.randomUUID()}`);
  const partsPattern = '**/uploads/**/parts/*';
  const parts = Promise.withResolvers<void>();
  await page.route(partsPattern, async (route) => {
    if (route.request().method() === 'PUT') await parts.promise;
    // A held part the page already gave up on (its idle timeout aborts and resends) has nothing left to continue.
    await route.continue().catch((err: unknown) => {
      if (!String(err).includes('already handled')) throw err;
    });
  });
  try {
    const dialog = await openImport(page);
    await dialog.locator('input[type="file"]').first().setInputFiles(sceneGlb(crypto.randomUUID()));
    await previewReady(dialog);
    await roomForUploads(1);
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
    const tab = page.getByTestId(`space-tab-${id}`);
    await tab.hover();
    await page.getByTestId(`space-tab-close-${id}`).click();
    await expect(page.getByText('An operation is still in progress — finish it before closing this Space.', { exact: true })).toBeVisible();
    await expect(tab).toHaveCount(1);
    // The Tasks panel the import opened stays until closed; the tab it lives in cannot close yet.
    await visibleSpace(page).getByTestId('scene-right-panel').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(visibleSpace(page).getByTestId('scene-tasks-panel')).toHaveCount(0);
  } finally {
    parts.resolve();
    // The held part is still on its way through the handler; let it finish before the route goes.
    await page.unrouteAll({ behavior: 'wait' });
    await deleteSpace(page, id);
  }
});

test('a failed transfer and a failed load keep existing objects; the task list retries the upload and the placement @needs-storage @needs-ingest', async ({ page }) => {
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
    await dialog.getByRole('textbox', { name: 'Model name', exact: true }).fill('Retried character');
    await roomForUploads(1);
    const firstTicket = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    const failed = await dataOf<Record<string, unknown>>(await firstTicket, 'open the first model upload');
    await expect(dialog).toHaveCount(0, { timeout: test.info().timeout });
    const failedRow = taskRow(page, failed.taskId);
    await expect(failedRow).toContainText('Failed', { timeout: test.info().timeout });
    expect(await sceneObjects(page, id)).toEqual([original]);
    failTransfer = false;
    await roomForUploads(1);
    const retryTicket = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await failedRow.getByRole('button', { name: 'Retry', exact: true }).click();
    const retried = await dataOf<Record<string, unknown>>(await retryTicket, 'open the retried model upload');
    expect(retried.taskId).not.toBe(failed.taskId);
    await expect(failedRow.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expect(failedRow.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    await placeFromTasks(page, retried.taskId);
    await expect(page.getByText('The model couldn’t be placed in the scene.', { exact: true })).toBeVisible({ timeout: test.info().timeout });
    expect(await sceneObjects(page, id)).toEqual([original]);
    failResolve = false;
    await placeFromTasks(page, retried.taskId);
    await expect.poll(async () => (await renderedObjects(page)).length, { timeout: test.info().timeout }).toBe(2);
    expect((await sceneObjects(page, id)).filter((object) => object.name === 'Retried character')).toHaveLength(1);
    expect((await sceneObjects(page, id)).find((object) => object.id === original.id)).toEqual(original);
  } finally {
    failTransfer = false;
    failResolve = false;
    await page.unroute(partsPattern);
    await page.unroute(assetsPattern);
    await deleteSpace(page, id);
  }
});

test('an editor\'s upload progress stays on everyone\'s task list while that editor has another tab on screen @needs-storage @needs-ingest', async ({ page, browser, baseURL }) => {
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
  const projectId = smokeProjectId();
  const partsPattern = '**/uploads/**/parts/*';
  const parts = Promise.withResolvers<void>();
  const spaces: string[] = [];
  let peerId: string | undefined;
  let peer: Page | undefined;
  try {
    await openSmokeProject(page);
    const id = await createSpace(page, '3d', `Shared progress ${crypto.randomUUID()}`);
    spaces.push(id);
    peerId = (await dataOf<{ id: string }>(await peerContext.request.get('/api/v1/auth/me'), 'read uploading account identity')).id;
    peer = await inviteMember(page, peerContext, projectId, credentialsFor('B').email, 'editor');
    watchUploadTickets(peer, 'B');
    await peer.route(partsPattern, async (route) => {
      if (route.request().method() === 'PUT') await parts.promise;
      await route.continue().catch((err: unknown) => {
        if (!String(err).includes('already handled')) throw err;
      });
    });
    await peer.goto(smokeProjectUrl());
    await reopenScene(peer, id);
    const dialog = await openImport(peer);
    await dialog.locator('input[type="file"]').first().setInputFiles(sceneGlb(crypto.randomUUID()));
    await previewReady(dialog);
    await roomForUploads(1, 'B');
    const ticketResponse = peer.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    const ticket = await dataOf<Record<string, unknown>>(await ticketResponse, 'open the held model upload');
    // The uploader moves to another Space; its 3D tab stays open behind it.
    spaces.push(await createSpace(peer, 'canvas', `Other tab ${crypto.randomUUID()}`));
    await openTasks(page);
    await expect(taskRow(page, ticket.taskId)).toContainText(/Uploading \d+%/, { timeout: 15_000 });
  } finally {
    parts.resolve();
    try {
      if (peer) await peer.unrouteAll({ behavior: 'wait' });
      await peerContext.close();
    } finally {
      try {
        if (peerId) await cleanMembership(page, projectId, peerId);
      } finally {
        for (const space of spaces) await deleteSpace(page, space);
      }
    }
  }
});

test('every member sees one task list: another editor\'s upload is placed by anyone, and a viewer only reads it @needs-storage @needs-ingest', async ({ page, browser, baseURL }) => {
  const peerContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
  const projectId = smokeProjectId();
  let id: string | undefined;
  let peerId: string | undefined;
  let peer: Page | undefined;
  try {
    await openSmokeProject(page);
    id = await createSpace(page, '3d', `Shared task list ${crypto.randomUUID()}`);
    peerId = (await dataOf<{ id: string }>(await peerContext.request.get('/api/v1/auth/me'), 'read uploading account identity')).id;
    peer = await inviteMember(page, peerContext, projectId, credentialsFor('B').email, 'editor');
    watchUploadTickets(peer, 'B');
    await peer.goto(smokeProjectUrl());
    await reopenScene(peer, id);
    const dialog = await openImport(peer);
    await dialog.locator('input[type="file"]').first().setInputFiles(sceneGlb(crypto.randomUUID()));
    await previewReady(dialog);
    await dialog.getByRole('textbox', { name: 'Model name', exact: true }).fill('Shared character');
    await roomForUploads(1, 'B');
    const ticketResponse = peer.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/assets/upload-ticket'
      && response.request().method() === 'POST', { timeout: test.info().timeout });
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    const ticket = await dataOf<Record<string, unknown>>(await ticketResponse, 'open the collaborator model upload');
    await openTasks(page);
    await expect(taskRow(page, ticket.taskId)).toContainText('Shared character', { timeout: test.info().timeout });
    await expect(taskRow(page, ticket.taskId)).toContainText('Done', { timeout: test.info().timeout });
    await placeFromTasks(page, ticket.taskId);
    await expect.poll(async () => (await renderedObjects(peer!)).length, { timeout: test.info().timeout }).toBe(1);
    await page.reload();
    await reopenScene(page, id);
    await openTasks(page);
    await expect(taskRow(page, ticket.taskId)).toContainText('Done');
    await dataOf(await page.request.patch(`/api/v1/projects/${projectId}/members/${peerId}`, { data: { role: 'viewer' } }), 'make the uploader a viewer');
    await peer.reload();
    await reopenScene(peer, id);
    await openTasks(peer);
    await expect(taskRow(peer, ticket.taskId)).toContainText('Shared character');
    // A viewer only reads the row: placing it was the editor's; locating what is in the scene is everyone's (design 7.3).
    await expect(taskRow(peer, ticket.taskId).getByRole('button')).toHaveText(['Locate in scene']);
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
