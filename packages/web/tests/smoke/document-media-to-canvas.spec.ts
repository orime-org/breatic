// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Pictures, videos and sounds copied in the document body paste onto the
 * canvas as nodes of their kind, by Cmd/Ctrl+V and by the pane menu's Paste
 * (inner#1537). A copy that also holds words stays one text node.
 */

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { wavBytes } from '../helpers/media-bytes';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, visibleSpace } from '../helpers/space';

const IMAGE = `${EDITOR} [data-content-type="image"]`;
const VIDEO = `${EDITOR} [data-content-type="video"]`;
const AUDIO = `${EDITOR} [data-content-type="audio"]`;

/** An upload goes to the real ingest Worker and back. */
const UPLOAD_TIMEOUT = 90_000;

const createdSpaceIds: string[] = [];

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: 1680, height: 950 });
});

test.afterEach(async ({ page }) => {
  await page.keyboard.press('Escape');
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/**
 * Opens a fresh Document Space with the caret in the body.
 * @param p - The page.
 * @returns The document Space id.
 */
async function openFreshDocument(p: Page): Promise<string> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `media-to-canvas-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  return id;
}

/**
 * A PNG drawn in the page in a colour no other run used, base64.
 * @param p - The page.
 * @returns The bytes.
 */
async function pngBase64(p: Page): Promise<string> {
  return p.evaluate(async (seed) => {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `hsl(${seed % 360} 60% 50%)`;
    ctx.fillRect(0, 0, 220, 120);
    ctx.fillText(String(seed), 10, 20);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), 'image/png'));
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let out = '';
    buffer.forEach((byte) => (out += String.fromCharCode(byte)));
    return btoa(out);
  }, Date.now() + Math.floor(Math.random() * 1000));
}

/**
 * A second of WebM recorded from a canvas in the page, base64.
 * @param p - The page.
 * @returns The bytes.
 */
async function webmBase64(p: Page): Promise<string> {
  return p.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d')!;
    const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise<void>((r) => (recorder.onstop = () => r()));
    recorder.start();
    let frame = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = `hsl(${(frame * 40 + Date.now()) % 360} 60% 50%)`;
      ctx.fillRect(0, 0, 160, 90);
      frame += 1;
    }, 60);
    await new Promise((r) => setTimeout(r, 1200));
    clearInterval(timer);
    recorder.stop();
    await done;
    const buffer = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let out = '';
    buffer.forEach((byte) => (out += String.fromCharCode(byte)));
    return btoa(out);
  });
}

/**
 * Pastes a file into the body the way the system clipboard hands one over.
 * @param p - The page.
 * @param base64 - Its bytes.
 * @param name - Its name.
 * @param type - Its MIME type.
 */
async function pasteFile(p: Page, base64: string, name: string, type: string): Promise<void> {
  await p.locator(EDITOR).evaluate(
    (element, [data, fileName, mime]) => {
      const transfer = new DataTransfer();
      const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      transfer.items.add(new File([raw], fileName, { type: mime }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    },
    [base64, name, type] as const,
  );
}

/**
 * Selects a media block as a user does: a click under it, then up.
 * @param p - The page.
 * @param block - The block's selector.
 */
async function selectBlock(p: Page, block: string): Promise<void> {
  const box = (await p.locator(block).last().boundingBox())!;
  await p.mouse.click(box.x + 4, box.y + box.height + 12);
  await p.keyboard.press('ArrowUp');
}

/**
 * Opens a new canvas Space and clicks its empty pane.
 * @param p - The page.
 * @returns The canvas pane.
 */
async function openCanvas(p: Page): Promise<Locator> {
  const id = await createSpace(p, 'canvas', `media-to-canvas-board-${Date.now()}`);
  createdSpaceIds.push(id);
  const pane = visibleSpace(p).locator('.react-flow__pane');
  await expect(pane).toBeVisible({ timeout: 15_000 });
  await pane.click({ position: { x: 40, y: 40 } });
  return pane;
}

/**
 * Pastes through the pane menu at a spot of the pane.
 * @param p - The page.
 * @param pane - The canvas pane.
 * @param at - The empty spot to right-click.
 */
async function pasteFromMenu(p: Page, pane: Locator, at = { x: 600, y: 400 }): Promise<void> {
  await pane.click({ button: 'right', position: at });
  await p.getByRole('menuitem', { name: /paste/i }).click();
}

test('a picture copied in the body pastes with Cmd/Ctrl+V as a picture node named after its file (A1, A4)', async ({ page }) => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await pasteFile(page, await pngBase64(page), 'probe.png', 'image/png');
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await page.locator(`${IMAGE} img`).click();
  await page.keyboard.press('ControlOrMeta+c');

  await openCanvas(page);
  await page.keyboard.press('ControlOrMeta+v');

  const node = visibleSpace(page).locator('.react-flow__node-image');
  await expect(node).toHaveCount(1, { timeout: 20_000 });
  await expect(node.getByTestId('node-header-name')).toHaveText('probe.png');
  await expect(node).toHaveClass(/selected/);
  await expect(node.locator('img').first()).toHaveAttribute('src', /\/image\//, { timeout: 20_000 });
  await expect(visibleSpace(page).locator('.react-flow__node-text')).toHaveCount(0);
});

test('a picture copied in the body pastes from the pane menu as a picture node (A3)', async ({ page }) => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await pasteFile(page, await pngBase64(page), 'menu.png', 'image/png');
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await page.locator(`${IMAGE} img`).click();
  await page.keyboard.press('ControlOrMeta+c');

  const pane = await openCanvas(page);
  await pasteFromMenu(page, pane);

  const node = visibleSpace(page).locator('.react-flow__node-image');
  await expect(node).toHaveCount(1, { timeout: 20_000 });
  await expect(node.getByTestId('node-header-name')).toHaveText('menu.png');
});

test('a video and a sound copied in the body paste from the pane menu as a video node with its cover and a sound node (A2, A3, A4)', async ({ page }) => {
  test.setTimeout(240_000);
  await openFreshDocument(page);
  await page.keyboard.type('Top');
  await pasteFile(page, await webmBase64(page), 'clip.webm', 'video/webm');
  await expect(page.locator(`${VIDEO} video`)).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  // A line under each medium, so a click under it lands on words, not on the next medium.
  await page.keyboard.type('Middle');
  await pasteFile(page, wavBytes().toString('base64'), 'tone.wav', 'audio/wav');
  await expect(page.locator(`${AUDIO} audio`)).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  const documentTab = (await page.locator('[data-testid^="space-tab-name-"]').last().getAttribute('data-testid'))!;

  await selectBlock(page, VIDEO);
  await page.keyboard.press('ControlOrMeta+c');
  const pane = await openCanvas(page);
  await pasteFromMenu(page, pane);
  const video = visibleSpace(page).locator('.react-flow__node-video');
  await expect(video).toHaveCount(1, { timeout: 20_000 });
  await expect(video.getByTestId('node-header-name')).toHaveText('clip.webm');
  await expect(video.locator('video')).toHaveAttribute('poster', /cover/, { timeout: 30_000 });

  await page.getByTestId(documentTab).click();
  await selectBlock(page, AUDIO);
  await page.keyboard.press('ControlOrMeta+c');
  await page.locator('[data-testid^="space-tab-name-"]').last().click();
  await pasteFromMenu(page, visibleSpace(page).locator('.react-flow__pane'), { x: 200, y: 700 });
  const audio = visibleSpace(page).locator('.react-flow__node-audio');
  await expect(audio).toHaveCount(1, { timeout: 20_000 });
  await expect(audio.getByTestId('node-header-name')).toHaveText('tone.wav');
});

test('two pictures copied from the end of a heading paste into one group named 2 files (A5)', async ({ page }) => {
  test.setTimeout(240_000);
  await openFreshDocument(page);
  await page.keyboard.type('# Shots');
  await page.keyboard.press('Enter');
  await pasteFile(page, await pngBase64(page), 'one.png', 'image/png');
  await expect(page.locator(`${IMAGE} img`)).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  await pasteFile(page, await pngBase64(page), 'two.png', 'image/png');
  await expect(page.locator(`${IMAGE} img`)).toHaveCount(2, { timeout: UPLOAD_TIMEOUT });

  // From the end of the heading's words to the start of the line after the pictures.
  await page.locator(`${EDITOR} h1, ${EDITOR} [data-content-type="heading"]`).first().click();
  await page.keyboard.press('End');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Shift');
  await page.keyboard.press('ControlOrMeta+c');

  await openCanvas(page);
  await page.keyboard.press('ControlOrMeta+v');

  const group = visibleSpace(page).locator('.react-flow__node-group');
  await expect(group).toHaveCount(1, { timeout: 20_000 });
  await expect(group.getByTestId('group-name')).toHaveText('2 files');
  await expect(visibleSpace(page).locator('.react-flow__node-image')).toHaveCount(2);
  await expect(visibleSpace(page).locator('.react-flow__node-image').getByTestId('node-header-name')).toHaveText(['one.png', 'two.png']);
});

test('words copied together with a picture paste as one text node (A6)', async ({ page }) => {
  test.setTimeout(180_000);
  await openFreshDocument(page);
  await page.keyboard.type('Words before');
  await pasteFile(page, await pngBase64(page), 'mixed.png', 'image/png');
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');

  await openCanvas(page);
  await page.keyboard.press('ControlOrMeta+v');

  await expect(visibleSpace(page).locator('.react-flow__node-text')).toHaveCount(1, { timeout: 20_000 });
  await expect(visibleSpace(page).locator('.react-flow__node-image')).toHaveCount(0);
});
