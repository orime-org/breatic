// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Images, videos and audio in a document body, end to end (inner#1127).
 *
 * What jsdom cannot show: a real upload through the ticket endpoint and the
 * ingest Worker, the picture loading from the address the server registered,
 * a real file picker, drop and paste, where the toolbar sits against the
 * media it serves, and the download opening a blank page.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR } from '../helpers/space';

let page: Page;

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

const IMAGE = `${EDITOR} [data-content-type="image"]`;
const VIDEO = `${EDITOR} [data-content-type="video"]`;
const AUDIO = `${EDITOR} [data-content-type="audio"]`;
const PLACEHOLDER = '[data-testid="doc-upload-placeholder"]';

/** An upload goes to the real ingest Worker and back. */
const UPLOAD_TIMEOUT = 60_000;

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 */
async function openFreshDocument(p: Page): Promise<void> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `media-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
}

/**
 * A PNG of this size, drawn in the page, with a colour no other run used so
 * the studio has not stored it before.
 * @param p - The page.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The bytes.
 */
async function pngBytes(p: Page, width = 480, height = 270): Promise<Buffer> {
  const base64 = await p.evaluate(
    async ([w, h, seed]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `hsl(${seed % 360} 60% 50%)`;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(seed), 10, 20);
      const blob = await new Promise<Blob>((done) => {
        canvas.toBlob((b) => done(b!), 'image/png');
      });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let out = '';
      buffer.forEach((byte) => {
        out += String.fromCharCode(byte);
      });
      return btoa(out);
    },
    [width, height, Date.now()] as const,
  );
  return Buffer.from(base64, 'base64');
}

/**
 * A short silent WAV, unique per call.
 * @returns The bytes.
 */
function wavBytes(): Buffer {
  const samples = 8000 + (Date.now() % 1000);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * The block types of the body, in order.
 * @param p - The page.
 * @returns One per row.
 */
async function types(p: Page): Promise<string[]> {
  return p.evaluate((selector) => {
    const root = document.querySelector(selector);
    return [...(root?.querySelectorAll('.bn-block-content') ?? [])].map(
      (row) => row.getAttribute('data-content-type') ?? '?',
    );
  }, EDITOR);
}

/**
 * Picks a file through the plus on the empty line's insert menu.
 * @param p - The page.
 * @param kind - The entry.
 * @param file - What to choose.
 * @param file.name - Its name.
 * @param file.mimeType - Its type.
 * @param file.buffer - Its bytes.
 */
async function pickFromPlus(
  p: Page,
  kind: 'image' | 'audio' | 'video',
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const firstRow = p.locator(`${EDITOR} .bn-block-content`).first();
  await firstRow.hover();
  await p.getByTestId('doc-block-plus').click();
  const chooser = p.waitForEvent('filechooser');
  await p.getByTestId(`doc-block-insert-${kind}`).click();
  await (await chooser).setFiles(file);
}

/**
 * Hands files to the body as a drop from outside the page, over a row.
 * @param p - The page.
 * @param target - The row to drop on.
 * @param files - The files.
 */
async function dropFiles(
  p: Page,
  target: string,
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  await p.locator(target).evaluate((element, list) => {
    const transfer = new DataTransfer();
    for (const { name, type, base64 } of list) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], name, { type }));
    }
    const box = element.getBoundingClientRect();
    const at = { clientX: box.left + box.width / 2, clientY: box.bottom - 2 };
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
  }, files);
}

test('the plus menu offers image, audio and video after the table, and a picked image lands (A1, A4, A7, A15)', async () => {
  await openFreshDocument(page);
  const firstRow = page.locator(`${EDITOR} .bn-block-content`).first();
  await firstRow.hover();
  await page.getByTestId('doc-block-plus').click();
  const order = await page
    .locator('[role="menuitem"][data-testid^="doc-block-insert-"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-testid')));
  expect(order.slice(-4)).toEqual([
    'doc-block-insert-table',
    'doc-block-insert-image',
    'doc-block-insert-audio',
    'doc-block-insert-video',
  ]);
  await page.keyboard.press('Escape');

  await pickFromPlus(page, 'image', {
    name: 'shot.png',
    mimeType: 'image/png',
    buffer: await pngBytes(page),
  });
  await expect(page.locator(PLACEHOLDER)).toBeVisible();
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
  // The picture loads from the address the server registered.
  await expect
    .poll(() => page.locator(`${IMAGE} img`).evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(480);
  expect(await types(page)).toEqual(['image', 'paragraph']);
});

test('dropped files land in the order they came in, at the drop (A2)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('Above');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Below');
  const png = (await pngBytes(page, 320, 180)).toString('base64');
  const wav = wavBytes().toString('base64');

  await dropFiles(page, `${EDITOR} .bn-block-content >> nth=0`, [
    { name: 'one.png', type: 'image/png', base64: png },
    { name: 'two.wav', type: 'audio/wav', base64: wav },
  ]);

  await expect(page.locator(PLACEHOLDER)).toHaveCount(2);
  await expect(page.locator(AUDIO)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await expect(page.locator(IMAGE)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  expect(await types(page)).toEqual(['paragraph', 'image', 'audio', 'paragraph']);
});

test('a pasted picture lands under the caret\'s line (A3)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('Line');
  const png = (await pngBytes(page, 200, 120)).toString('base64');

  await page.locator(EDITOR).evaluate((element, base64) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);

  await expect(page.locator(IMAGE)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  expect(await types(page)).toEqual(['paragraph', 'image']);
});

test('a format we do not take is refused with a toast and leaves nothing (A5)', async () => {
  await openFreshDocument(page);

  await dropFiles(page, `${EDITOR} .bn-block-content >> nth=0`, [
    { name: 'loop.gif', type: 'image/gif', base64: 'R0lGODlhAQABAAAAACw=' },
  ]);

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'loop.gif' })).toBeVisible();
  await expect(page.locator(PLACEHOLDER)).toHaveCount(0);
  expect(await types(page)).toEqual(['paragraph']);
});

test('pictures in pasted web content are left out, and the words come in (A18)', async () => {
  await openFreshDocument(page);

  await page.locator(EDITOR).evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', '<p>words</p><img src="https://example.org/a.png">');
    transfer.setData('text/plain', 'words');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });

  await expect(page.locator('[data-sonner-toast]').filter({ hasText: /not pasted/ })).toBeVisible();
  await expect(page.locator(EDITOR)).toContainText('words');
  expect(await types(page)).not.toContain('image');
});

test('the toolbar sits above the media, centred, covering none of it, and works (A9, A16, A17, A19)', async () => {
  await openFreshDocument(page);
  await pickFromPlus(page, 'image', {
    name: 'tool.png',
    mimeType: 'image/png',
    buffer: await pngBytes(page, 400, 240),
  });
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });

  await img.hover();
  const toolbar = page.locator(`${IMAGE} [data-testid="doc-media-toolbar"]`);
  await expect(toolbar).toBeVisible();
  const [bar, media, scroller] = await Promise.all([
    toolbar.boundingBox(),
    img.boundingBox(),
    page.locator('[data-testid="document-space"] [data-radix-scroll-area-viewport]').first().boundingBox(),
  ]);
  // The first block has no room above it inside the scroller, so the bar sits
  // under the picture; either way it covers none of it and is all in view.
  const clearOfMedia = bar!.y + bar!.height <= media!.y || bar!.y >= media!.y + media!.height;
  expect(clearOfMedia).toBe(true);
  expect(bar!.y).toBeGreaterThanOrEqual(scroller!.y);
  expect(Math.abs(bar!.x + bar!.width / 2 - (media!.x + media!.width / 2))).toBeLessThan(1);

  // Narrower than the body, so alignment is offered.
  await page.getByTestId('doc-media-align-center').click();
  await expect(page.locator(IMAGE)).toHaveAttribute('data-text-alignment', 'center');
  const centred = (await img.boundingBox())!;
  const row = (await page.locator(`${IMAGE} [data-testid="doc-media-row"]`).boundingBox())!;
  expect(Math.abs(centred.x + centred.width / 2 - (row.x + row.width / 2))).toBeLessThan(1);

  await img.hover();
  await page.getByTestId('doc-media-caption-button').click();
  await page.getByTestId('doc-media-caption-input').fill('Dusk');
  await page.keyboard.press('Enter');
  await expect(page.locator(`${IMAGE} [data-testid="doc-media-caption"]`)).toHaveText('Dusk');

  await img.dblclick();
  await expect(page.getByTestId('doc-media-fullscreen-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-media-fullscreen-image')).toHaveCount(0);
});

test('the toolbar hands the stored file to the browser as a download (A19) @needs-ingest @needs-storage', async () => {
  await openFreshDocument(page);
  const bytes = await pngBytes(page, 160, 90);
  await pickFromPlus(page, 'image', { name: 'keep.png', mimeType: 'image/png', buffer: bytes });
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const stored = await img.evaluate((element) => (element as HTMLImageElement).src);

  await img.hover();
  // The same path the canvas node menu takes: a navigation instead of a
  // download would leave this waiting.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('doc-media-download').click(),
  ]);

  expect(download.suggestedFilename()).toBe(
    decodeURIComponent(new URL(stored).pathname.split('/').pop() ?? ''),
  );
  expect(readFileSync(await download.path()).equals(bytes)).toBe(true);
});

test('the toolbar sits above a picture with lines above it (A9)', async () => {
  await openFreshDocument(page);
  for (let line = 0; line < 4; line += 1) {
    await page.keyboard.type(`Line ${line}`);
    await page.keyboard.press('Enter');
  }
  const png = (await pngBytes(page, 300, 160)).toString('base64');
  await page.locator(EDITOR).evaluate((element, base64) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'mid.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });

  await img.hover();
  const toolbar = page.locator(`${IMAGE} [data-testid="doc-media-toolbar"]`);
  await expect(toolbar).toHaveAttribute('data-side', 'top');
  const [bar, media] = await Promise.all([toolbar.boundingBox(), img.boundingBox()]);
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(media!.y);
  expect(Math.abs(bar!.x + bar!.width / 2 - (media!.x + media!.width / 2))).toBeLessThan(1);

  // Moving up onto the bar slowly, through the gap between it and the
  // picture, keeps it up: the pointer never leaves the media's frame.
  const centre = page.locator(`${IMAGE} [data-testid="doc-media-align-center"]`);
  const target = (await centre.boundingBox())!;
  await page.mouse.move(media!.x + media!.width / 2, media!.y + 4);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await expect(toolbar).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(IMAGE)).toHaveAttribute('data-text-alignment', 'center');
});

test('a selected picture is framed with a knob on each corner, and its handle stands at its top (A8, A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('Above');
  await page.keyboard.press('Enter');
  const png = (await pngBytes(page, 300, 400)).toString('base64');
  await page.locator(EDITOR).evaluate((element, base64) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'tall.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, png);
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });

  await img.hover();
  const handle = page.getByTestId('doc-block-handle');
  await expect(handle).toBeVisible();
  const [grip, media] = await Promise.all([handle.boundingBox(), img.boundingBox()]);
  expect(grip!.y + grip!.height / 2).toBeLessThan(media!.y + 30);

  // The pointer alone frames it, in the selected text's own colour.
  const frame = page.locator(`${IMAGE} [data-media-frame]`);
  const selectionColour = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--color-selection)';
    document.querySelector('.doc-body')!.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(frame).toHaveCSS('outline-style', 'solid');
  await expect(frame).toHaveCSS('outline-color', selectionColour);
  const hoveredOutline = await frame.evaluate((element) => getComputedStyle(element).outline);

  await img.click();
  await expect(frame).toHaveCSS('outline-width', '1px');
  expect(await frame.evaluate((element) => getComputedStyle(element).outline)).toBe(hoveredOutline);
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    await expect(page.getByTestId(`doc-media-resize-${corner}`)).toBeVisible();
  }
  await expect(page.locator(IMAGE)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  // The frame stops at the media: a caption under it is outside.
  await page.locator(`${IMAGE} [data-testid="doc-media-caption-button"]`).click();
  await page.locator(`${IMAGE} [data-testid="doc-media-caption-input"]`).fill('A note');
  await page.keyboard.press('Enter');
  const [frameBox, captionBox] = await Promise.all([
    frame.boundingBox(),
    page.locator(`${IMAGE} [data-testid="doc-media-caption"]`).boundingBox(),
  ]);
  expect(frameBox!.y + frameBox!.height).toBeLessThanOrEqual(captionBox!.y);

  // The handle comes back on the next visit after a click (it used to stay away).
  await page.mouse.move(5, 5);
  await img.hover();
  await expect(handle).toBeVisible();
});

test('the document shows one bar at a time (inner#1127)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('hello world');
  await page.keyboard.press('Enter');
  for (const name of ['one.png', 'two.png']) {
    const png = (await pngBytes(page, 200, 120)).toString('base64');
    await page.locator(EDITOR).evaluate((element, [base64, file]) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], file!, { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, [png, name]);
    await expect(page.locator(`${IMAGE} img`).last()).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  }
  const pictures = page.locator(IMAGE);
  await expect(pictures).toHaveCount(2);
  const visibleToolbars = page.locator('[data-testid="doc-media-toolbar"]:visible');

  // One picture selected, the other under the pointer: only the latter's bar.
  await pictures.nth(0).locator('img').click();
  await expect(visibleToolbars).toHaveCount(1);
  await pictures.nth(1).locator('img').hover();
  await expect(visibleToolbars).toHaveCount(1);
  await expect(pictures.nth(1).locator('[data-testid="doc-media-toolbar"]')).toBeVisible();
  await expect(pictures.nth(1).locator('[data-media-frame]')).toHaveCSS('outline-style', 'solid');

  // Text selected, a picture under the pointer: the bubble bar steps aside.
  await page.locator(`${EDITOR} p`).first().dblclick();
  const bubble = page.getByTestId('doc-selection-bubble-bar');
  await expect(bubble).toBeVisible();
  await pictures.nth(1).locator('img').hover();
  await expect(bubble).toBeHidden();
  await expect(visibleToolbars).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(bubble).toBeVisible();
  await expect(visibleToolbars).toHaveCount(0);
});

test('a video plays in place and keeps playing while its width changes (A7, A8)', async () => {
  await openFreshDocument(page);
  await pickFromPlus(page, 'video', {
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
  });
  const video = page.locator(`${VIDEO} video`);
  await expect(video).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const handle = page.locator(`${VIDEO} [data-testid="doc-media-resize-se"]`);
  const element = await video.elementHandle();

  await page.locator(VIDEO).click({ position: { x: 20, y: 20 } });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect.poll(() => page.locator(VIDEO).getAttribute('data-preview-width')).not.toBeNull();
  // The same element: the block redrew in place rather than being rebuilt.
  expect(await page.locator(`${VIDEO} video`).evaluate((v, before) => v === before, element)).toBe(true);
});

/**
 * Pastes a fresh picture under the caret's line.
 * @param p - The page.
 * @param name - The file's name.
 */
async function pastePicture(p: Page, name: string): Promise<void> {
  const png = (await pngBytes(p, 220, 120)).toString('base64');
  await p.locator(EDITOR).evaluate(
    (element, [base64, fileName]) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], fileName, { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    },
    [png, name] as const,
  );
}

test('a failed upload says so in place, and a retry lands it (A6)', async () => {
  await openFreshDocument(page);
  await page.route('**/api/v1/assets/upload-ticket', (route) => route.fulfill({ status: 500, body: '{}' }));

  await pastePicture(page, 'flaky.png');

  const placeholder = page.locator(PLACEHOLDER);
  await expect(placeholder).toHaveAttribute('data-phase', 'failed', { timeout: 30_000 });
  await expect(placeholder).toContainText('flaky.png');
  await page.unroute('**/api/v1/assets/upload-ticket');
  await page.getByTestId('doc-upload-retry').click();

  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await expect(placeholder).toHaveCount(0);
});

test('closing the tab during an upload asks first (A12)', async () => {
  await openFreshDocument(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/v1/assets/upload-ticket', async (route) => {
    await held;
    await route.continue();
  });

  await pastePicture(page, 'held.png');
  await expect(page.locator(PLACEHOLDER)).toHaveAttribute('data-phase', 'uploading');

  // The page's close guard asks the registry of operations in flight; the
  // browser's own prompt is shown on that answer.
  const leaveIsHeld = (): Promise<boolean> =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await leaveIsHeld()).toBe(true);

  release();
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  expect(await leaveIsHeld()).toBe(false);
});

test('a picture is still there after a reload (A13)', async () => {
  await openFreshDocument(page);
  await pastePicture(page, 'kept.png');
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });

  await page.reload();

  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => img.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(220);
});
