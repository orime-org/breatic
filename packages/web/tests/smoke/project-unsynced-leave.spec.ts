// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as decoding from 'lib0/decoding';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR, visibleSpace } from '../helpers/space';
import { liveModuleUrl, YJS_MANAGER, CANVAS_SPACE } from '../helpers/live-module';

interface Content {
  projectId: string;
  spaceId: string;
  kind: 'canvas' | 'document';
}

const errors = new WeakMap<Page, string[]>();
const rejectedUpload = new WeakSet<Page>();

/** Records unexpected browser errors separately from the connection drop exercised here. */
function monitorPage(page: Page): void {
  const found: string[] = [];
  errors.set(page, found);
  page.on('pageerror', (error) => found.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (message.text().startsWith('[collab] collab disconnect')) return;
    if (rejectedUpload.has(page) && message.location().url.includes('/api/v1/assets/upload-ticket') && message.text().includes('422')) return;
    found.push(message.text());
  });
}

test.beforeEach(({ page }) => { monitorPage(page); });
test.afterEach(({ page }) => { expect(errors.get(page)).toEqual([]); });

/** Applies the actual persisted theme setting used by the Project chrome. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const url = await liveModuleUrl(page, 'stores/preferences.ts');
  await page.evaluate(async ({ url: at, theme: next }) => {
    const preferences = await import(at);
    preferences.usePreferencesStore.getState().setTheme(next);
  }, { url, theme });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Records the visible modal geometry and its actual theme, then captures it. */
async function recordDialog(page: Page, theme: 'light' | 'dark', locale = 'en'): Promise<void> {
  const copy = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales', `${locale}.json`), 'utf8')) as { common: { cancel: string }; project: { refreshGuard: { refresh: string } } };
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
  const measurement = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { theme: document.documentElement.dataset.theme, width: rect.width, height: rect.height, background: style.backgroundColor, border: style.borderWidth, contentWidth: element.scrollWidth, innerWidth: element.clientWidth, buttons: Array.from(element.querySelectorAll('button')).map((button) => button.textContent) };
  });
  expect(measurement.theme).toBe(theme);
  expect(measurement.width).toBe(512);
  expect(measurement.border).toBe('1px');
  expect(measurement.contentWidth).toBeLessThanOrEqual(measurement.innerWidth);
  expect(measurement.buttons).toEqual([copy.common.cancel, copy.project.refreshGuard.refresh]);
  console.warn('UNSYNCED_UI_CHECK_1641', JSON.stringify({ locale, ...measurement }));
  await page.screenshot({ path: test.info().outputPath(`unsynced-${locale}-${theme}.png`), fullPage: true });
}

/** Checks the same live pending edit in every locale and both actual themes. */
async function localizedRefreshChoices(page: Page): Promise<void> {
  const url = await liveModuleUrl(page, 'i18n/locale-bootstrap.ts');
  try {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko']) {
      await page.evaluate(async ({ url: at, locale: next }) => { (await import(at)).changeLocale(next); }, { url, locale });
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await page.getByTestId('connection-banner-reload').click();
        await recordDialog(page, theme, locale);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
      }
    }
  } finally {
    await page.evaluate(async (at) => { (await import(at)).changeLocale('en'); }, url);
    await setTheme(page, 'light');
  }
}

/** Reads the actual registered provider and its Project risk. */
async function contentState(page: Page, content: Content, connected?: boolean): Promise<boolean> {
  const managerUrl = await liveModuleUrl(page, YJS_MANAGER);
  const socketUrl = await liveModuleUrl(page, 'data/yjs/collab-socket.tsx');
  return page.evaluate(async ({ managerUrl: managerAt, socketUrl: socketAt, content: item, connected: connect }) => {
    const manager = await import(managerAt);
    const socket = await import(socketAt);
    const name = item.kind === 'canvas' ? manager.docName.canvasSpace(item.projectId, item.spaceId) : manager.docName.documentSpace(item.projectId, item.spaceId);
    if (!manager.hasDoc(name)) throw new Error('The live content document is not registered');
    const provider = socket.readDocProvider(name);
    if (provider === null) throw new Error('The live content provider is missing');
    if (connect === false) provider.configuration.websocketProvider.disconnect();
    if (connect === true) await provider.configuration.websocketProvider.connect();
    return socket.hasProjectUnsyncedEdits(item.projectId) as boolean;
  }, { managerUrl, socketUrl, content, connected });
}

/** Waits for the production correlated receipt to cover current edits. */
async function synced(page: Page, content: Content): Promise<void> {
  await expect.poll(() => contentState(page, content)).toBe(false);
}

/** Restores connectivity and removes exactly the Spaces owned by the case. */
async function cleanupSpaces(page: Page, content: Content, spaceIds: string[], projectUrl: string): Promise<void> {
  if (page.url().includes('/project/')) {
    await contentState(page, content, true);
    await synced(page, content);
  } else {
    await page.goto(projectUrl);
  }
  for (const id of spaceIds) await deleteSpace(page, id);
}

test('Document edits survive cancelled refresh and leave, then sync to another client', async ({ page, context }) => {
  await openSmokeProject(page);
  const projectUrl = page.url();
  const projectId = smokeProjectId();
  const made: string[] = [];
  const nativeDialogs: string[] = [];
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  const documentId = await createSpace(page, 'document', `unsynced-doc-${Date.now()}`);
  made.push(documentId);
  const item: Content = { projectId, spaceId: documentId, kind: 'document' };
  let peer: Page | undefined;
  try {
    await setTheme(page, 'light');
    const editor = page.locator(DOCUMENT_EDITOR);
    await editor.click();
    await page.keyboard.type('Saved text. ');
    await synced(page, item);
    const canvasId = await createSpace(page, 'canvas', `unsynced-background-${Date.now()}`);
    made.push(canvasId);
    await page.getByTestId(`space-tab-${documentId}`).click();
    await editor.click();
    await contentState(page, item, false);
    const marker = 'LOCAL_DOCUMENT_EDIT_1641';
    await page.keyboard.type(marker);
    await expect(editor).toContainText(marker);
    expect(await contentState(page, item)).toBe(true);
    await page.getByTestId('connection-banner-reload').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Some changes have not synced');
    await recordDialog(page, 'light');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(editor).toContainText(marker);
    await expect(page.getByTestId('connection-banner-reload')).toBeFocused();
    expect(nativeDialogs).toEqual([]);
    await localizedRefreshChoices(page);
    await expect(editor).toContainText(marker);

    await page.getByTestId(`space-tab-${canvasId}`).press('Enter');
    await expect(visibleSpace(page).getByTestId('canvas-space')).toBeVisible();
    await page.getByTestId('top-bar-back').press('Enter');
    await expect(dialog).toContainText('Some changes have not synced');
    await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
    await expect(page).toHaveURL(projectUrl);
    await page.getByTestId(`space-tab-${documentId}`).press('Enter');
    await expect(editor).toContainText(marker);

    await page.reload({ timeout: 5_000 }).catch((error: unknown) => {
      expect(String(error)).toMatch(/ERR_ABORTED|Timeout/);
    });
    expect(nativeDialogs).toEqual(['beforeunload']);
    await expect(editor).toContainText(marker);

    await contentState(page, item, true);
    await synced(page, item);
    peer = await context.newPage();
    monitorPage(peer);
    await peer.goto(projectUrl);
    await peer.getByTestId(`space-tab-${documentId}`).click();
    await expect(peer.locator(DOCUMENT_EDITOR)).toContainText(marker);
    const peerItem = { ...item };
    expect(await contentState(peer, peerItem)).toBe(false);
    expect(errors.get(peer)).toEqual([]);
    await peer.close();
    peer = undefined;
    await page.getByTestId('top-bar-back').click();
    await expect(page).toHaveURL(/\/studio$/);
    expect(nativeDialogs).toEqual(['beforeunload']);
  } finally {
    await peer?.close();
    await cleanupSpaces(page, item, made, projectUrl);
  }
});

test('Canvas refresh confirmation reloads once after a local rename', async ({ page }) => {
  await openSmokeProject(page);
  const projectUrl = page.url();
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `unsynced-canvas-${Date.now()}`);
  const item: Content = { projectId, spaceId, kind: 'canvas' };
  const nativeDialogs: string[] = [];
  page.on('dialog', async (dialog) => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
  try {
    await setTheme(page, 'dark');
    const canvasUrl = await liveModuleUrl(page, CANVAS_SPACE);
    const nodeId = crypto.randomUUID();
    await page.evaluate(async ({ canvasUrl: url, projectId: pid, spaceId: sid, nodeId: id }) => {
      const canvas = await import(url);
      canvas.addNode(pid, sid, { id, type: 'text', position: { x: 100, y: 100 }, data: { name: 'Saved node', createdAt: Date.now(), createdBy: 'smoke', locked: false, state: 'idle', attachments: [] } });
      if (canvas.readCanvasGraph(pid, sid).nodes.length !== 1) throw new Error('The seeded node did not reach the live canvas');
    }, { canvasUrl, projectId, spaceId, nodeId });
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node).toBeVisible();
    await synced(page, item);
    await node.getByTestId('node-header-name').dblclick();
    const name = node.getByTestId('node-header-input');
    await expect(name).toBeFocused();
    await contentState(page, item, false);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('Local rename');
    await page.keyboard.press('Enter');
    expect(await contentState(page, item)).toBe(true);
    await page.getByTestId('connection-banner-reload').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await recordDialog(page, 'dark');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(node.getByTestId('node-header-name')).toHaveText('Local rename');
    await page.getByTestId('connection-banner-reload').click();
    await Promise.all([
      page.waitForEvent('load'),
      dialog.getByRole('button', { name: 'Refresh anyway', exact: true }).click(),
    ]);
    await expect(page.getByTestId(`space-tab-${spaceId}`)).toBeVisible();
    await page.getByTestId(`space-tab-${spaceId}`).click();
    await expect(node.getByTestId('node-header-name')).toHaveText('Saved node');
    expect(nativeDialogs).toEqual([]);
    await synced(page, item);
  } finally { await cleanupSpaces(page, item, [spaceId], projectUrl); }
});

test('a real pending Document upload keeps refresh and browser leave protected', async ({ page }) => {
  await openSmokeProject(page);
  const projectUrl = page.url();
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'document', `upload-guard-${Date.now()}`);
  const item: Content = { projectId, spaceId, kind: 'document' };
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/assets/upload-ticket', async (route) => {
    await held;
    rejectedUpload.add(page);
    await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Upload rejected by the test fixture' } }) });
  });
  try {
    const editor = page.locator(DOCUMENT_EDITOR);
    await editor.click();
    await editor.evaluate((element) => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'held.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    const placeholder = editor.locator('[data-phase="uploading"]');
    await expect(placeholder).toBeVisible();
    await synced(page, item);
    await contentState(page, item, false);
    await page.getByTestId('connection-banner-reload').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('An upload or edit');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(placeholder).toBeVisible();
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
    release();
    await expect(editor.locator('[data-phase="failed"]')).toBeVisible();
    await contentState(page, item, true);
    await synced(page, item);
    expect(await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(false);
  } finally {
    release();
    await cleanupSpaces(page, item, [spaceId], projectUrl);
  }
});

/** The fields needed to correlate application frames while preserving wire order. */
interface Frame {
  name: string;
  kind: string;
}

/** Decodes only the existing protocol header and application message type. */
function frameOf(data: string | Buffer): Frame {
  const decoder = decoding.createDecoder(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  const name = decoding.readVarString(decoder);
  const type = decoding.readVarUint(decoder);
  let kind = `wire:${type}`;
  if (type === 0) kind = `sync:${decoding.readVarUint(decoder)}`;
  if (type === 5) {
    const payload = decoding.readVarString(decoder);
    kind = 'stateless';
    if (payload.startsWith('{')) kind = (JSON.parse(payload) as { type: string }).type;
  }
  return { name, kind };
}

test('an older real receipt keeps newer Document edits protected until their round trip', async ({ page, context }) => {
  let name = '';
  let holdResponses = false;
  let holdOutgoing = false;
  const replies: Array<() => void> = [];
  const outgoing: Array<() => void> = [];
  const sent: Frame[] = [];
  await page.routeWebSocket('**/ws', (route) => {
    const server = route.connectToServer();
    route.onMessage((data) => {
      const frame = frameOf(data);
      sent.push(frame);
      if (holdOutgoing && frame.name === name) outgoing.push(() => server.send(data));
      else server.send(data);
    });
    server.onMessage((data) => {
      const frame = frameOf(data);
      if (holdResponses && frame.name === name && frame.kind === 'sync:confirmed') replies.push(() => route.send(data));
      else route.send(data);
    });
  });
  await openSmokeProject(page);
  const projectUrl = page.url();
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'document', `receipt-order-${Date.now()}`);
  const item: Content = { projectId, spaceId, kind: 'document' };
  name = `project-${projectId}/document-${spaceId}`;
  let peer: Page | undefined;
  try {
    const editor = page.locator(DOCUMENT_EDITOR);
    await editor.click();
    await page.keyboard.type('Base ');
    await synced(page, item);
    holdResponses = true;
    await page.keyboard.type('A');
    await expect.poll(() => replies.length).toBe(1);
    holdOutgoing = true;
    await page.keyboard.type('B');
    await expect.poll(() => outgoing.length).toBeGreaterThan(0);
    holdResponses = false;
    replies.shift()!();
    await expect.poll(() => outgoing.length).toBeGreaterThan(1);
    expect(await contentState(page, item)).toBe(true);
    await page.getByTestId('top-bar-back').click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Some changes have not synced');
    await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
    holdOutgoing = false;
    for (const send of outgoing.splice(0)) send();
    await synced(page, item);
    const contentFrames = sent.filter((frame) => frame.name === name).map((frame) => frame.kind);
    const firstReceipt = contentFrames.indexOf('sync:confirm');
    expect(firstReceipt).toBeGreaterThan(contentFrames.indexOf('sync:1'));
    expect(contentFrames.slice(0, firstReceipt)).toContain('sync:2');
    peer = await context.newPage();
    monitorPage(peer);
    await peer.goto(projectUrl);
    await peer.getByTestId(`space-tab-${spaceId}`).click();
    await expect(peer.locator(DOCUMENT_EDITOR)).toContainText('Base AB');
    expect(await contentState(peer, item)).toBe(false);
    expect(errors.get(peer)).toEqual([]);
  } finally {
    holdResponses = false;
    holdOutgoing = false;
    for (const send of outgoing.splice(0)) send();
    for (const send of replies.splice(0)) send();
    await peer?.close();
    await cleanupSpaces(page, item, [spaceId], projectUrl);
  }
});
