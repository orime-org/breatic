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

test('the toolbar of a first block sits on the picture, never under it, centred, and works (A9, A16, A17, A19)', async () => {
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
  // on the picture along its top edge, all in view.
  await expect(toolbar).toHaveAttribute('data-side', 'inside');
  expect(bar!.y).toBeGreaterThan(media!.y);
  expect(bar!.y + bar!.height).toBeLessThan(media!.y + media!.height / 2);
  expect(bar!.y).toBeGreaterThanOrEqual(scroller!.y);

  // Delete is drawn in the error red.
  const red = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'text-status-error-foreground';
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(page.locator(`${IMAGE} [data-testid="doc-media-delete"]`)).toHaveCSS('color', red);
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

  // The first block's bar sits on the picture's top, so the pointer rests low.
  await img.hover({ position: { x: 4, y: 86 } });
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

  // The pointer alone frames it, in the link colour.
  const frame = page.locator(`${IMAGE} [data-media-frame]`);
  const linkColour = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--color-content-link)';
    document.querySelector('.doc-body')!.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
  await expect(frame).toHaveCSS('outline-style', 'solid');
  await expect(frame).toHaveCSS('outline-color', linkColour);
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
  await page.keyboard.type('hello world, a line that runs on past the pictures');
  await page.keyboard.press('Enter');
  for (const [index, name] of ['one.png', 'two.png'].entries()) {
    const png = (await pngBytes(page, 200, 120)).toString('base64');
    await page.locator(EDITOR).evaluate((element, [base64, file]) => {
      const transfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(base64!), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], file!, { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, [png, name]);
    await expect(page.locator(`${IMAGE} img`)).toHaveCount(index + 1, { timeout: UPLOAD_TIMEOUT });
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
  // The last word, out past the selected picture's bar, which covers the
  // start of the line while it is up.
  const word = await page.locator(EDITOR).evaluate((element) => {
    const text = [...element.querySelectorAll('p')].find((p) => p.textContent?.startsWith('hello'))!.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - 3);
    range.setEnd(text, text.textContent!.length);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.dblclick(word.x, word.y);
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

  await selectFromBelow(page, VIDEO);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect.poll(() => page.locator(VIDEO).getAttribute('data-preview-width')).not.toBeNull();
  // The same element: the block redrew in place rather than being rebuilt.
  expect(await page.locator(`${VIDEO} video`).evaluate((v, before) => v === before, element)).toBe(true);
});

test('a narrow video keeps play, seek and full screen inside it, and shows its times once it is wide (A7)', async () => {
  await openFreshDocument(page);
  await pickFromPlus(page, 'video', {
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
  });
  const video = page.locator(VIDEO);
  await expect(video.locator('video')).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const fits = (): Promise<{ inside: boolean; times: boolean; width: number }> =>
    video.evaluate((block) => {
      const controls = block.querySelector('[data-testid="controls"]') as HTMLElement;
      const frame = block.querySelector('[data-media-frame]')!.getBoundingClientRect();
      const inside = ['play-toggle', 'seek', 'fullscreen'].every((id) => {
        const box = block.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
        return box.width > 0 && box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5;
      });
      const time = block.querySelector('[data-testid="time-current"]') as HTMLElement;
      return { inside: inside && controls.scrollWidth <= controls.clientWidth, times: time.offsetWidth > 0, width: Math.round(frame.width) };
    });

  // The source is 64px wide; the block holds the player's narrowest.
  expect(await fits()).toEqual({ inside: true, times: false, width: 128 });

  await selectFromBelow(page, VIDEO);
  const handle = page.locator(`${VIDEO} [data-testid="doc-media-resize-se"]`);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await fits()).times).toBe(true);
  expect((await fits()).inside).toBe(true);
});

/**
 * Selects the media block from the line under it, with the up arrow.
 * @param p - The page.
 * @param block - The media block.
 */
async function selectFromBelow(p: Page, block: string): Promise<void> {
  const box = (await p.locator(block).boundingBox())!;
  await p.mouse.click(box.x + 4, box.y + box.height + 12);
  await p.keyboard.press('ArrowUp');
  await expect(p.locator(`${block} [data-testid="doc-media-resize-se"]`)).toBeVisible();
}

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

test('a picture is no longer selected once the focus leaves the body, and never re-frames when another is picked (A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await pastePicture(page, 'first.png');
  await expect(page.locator(`${IMAGE} img`)).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  await page.keyboard.press('ArrowDown');
  await pastePicture(page, 'second.png');
  const first = page.locator(IMAGE).nth(0);
  const second = page.locator(IMAGE).nth(1);
  await expect(second.locator('img')).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await expect(first.locator('img')).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const outlineOf = (block: typeof first): Promise<string> =>
    block.locator('[data-media-frame]').evaluate((frame) => getComputedStyle(frame).outlineStyle);
  const knob = (block: typeof first) => block.locator('[data-testid="doc-media-resize-se"]');

  await first.locator('img').click();
  await expect(knob(first)).toBeVisible();
  expect(await outlineOf(first)).toBe('solid');

  // A menu outside the body takes the focus: nothing in the body is selected
  // any more, so the frame, the corner knobs and the toolbar all go.
  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('theme-popover')).toBeVisible();
  await expect(knob(first)).toHaveCount(0);
  expect(await outlineOf(first)).toBe('none');
  await expect(first.locator('[data-testid="doc-media-toolbar"][data-shown="true"]')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('theme-popover')).toBeHidden();

  // Every frame of the first picture's outline while the second is clicked.
  await first.locator('[data-media-frame]').evaluate((frame) => {
    const seen: string[] = [];
    (window as unknown as { seenOutline: string[] }).seenOutline = seen;
    const sample = (): void => {
      seen.push(getComputedStyle(frame).outlineStyle);
      if (seen.length < 120) requestAnimationFrame(sample);
    };
    sample();
  });
  // A hand's click: the button is held for a moment before it comes up.
  const target = (await second.locator('img').boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(knob(second)).toBeVisible();
  await page.waitForFunction(() => (window as unknown as { seenOutline: string[] }).seenOutline.length >= 120);
  const seen = await page.evaluate(() => (window as unknown as { seenOutline: string[] }).seenOutline);
  expect(seen).not.toContain('solid');
  await expect(knob(first)).toHaveCount(0);
  // The caret the body kept while the menu had the focus is not drawn.
  expect(
    await page.evaluate(() => {
      const selection = getSelection();
      const at = selection?.anchorNode;
      const holder = at instanceof Element ? at : at?.parentElement;
      return (
        selection?.isCollapsed === true &&
        holder instanceof HTMLElement &&
        holder.isContentEditable &&
        getComputedStyle(holder).caretColor !== 'rgba(0, 0, 0, 0)'
      );
    }),
  ).toBe(false);
});

test('a picture or a video is selected by a click on what it shows, never on the empty row beside it (A10)', async () => {
  await openFreshDocument(page);
  await pickFromPlus(page, 'video', {
    name: 'beside.mp4',
    mimeType: 'video/mp4',
    buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
  });
  const video = page.locator(VIDEO);
  await expect(video.locator('video')).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await page.locator(`${EDITOR} .bn-block-content`).last().click();
  await pastePicture(page, 'beside.png');
  const picture = page.locator(IMAGE);
  await expect(picture.locator('img')).toBeVisible({ timeout: UPLOAD_TIMEOUT });

  for (const block of [picture, video]) {
    const frame = (await block.locator('[data-media-frame]').boundingBox())!;
    const row = (await block.boundingBox())!;
    // The empty part of the row, to the right of what the block shows.
    expect(row.x + row.width - (frame.x + frame.width)).toBeGreaterThan(80);
    await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2);
    await expect(block.locator('[data-testid="doc-media-resize-se"]')).toHaveCount(0);
    expect(await block.locator('[data-media-frame]').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');

    // Nor does a triple click there.
    await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2, { clickCount: 3 });
    await expect(block.locator('[data-testid="doc-media-resize-se"]')).toHaveCount(0);

    // What it shows still selects it: its middle, clear of the toolbar a
    // first block carries along its top edge and the player's controls.
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await expect(block.locator('[data-testid="doc-media-resize-se"]')).toBeVisible();
  }
});

test('the keyboard stays with the body through the toolbar and the caption; a press beside the picture or on its caption selects nothing (A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('omega');
  await page.keyboard.press('ArrowUp');
  await pastePicture(page, 'keys.png');
  const picture = page.locator(IMAGE);
  await expect(picture.locator('img')).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const knob = picture.locator('[data-testid="doc-media-resize-se"]');
  const img = picture.locator('img');

  // A toolbar button leaves the keys with the body: Backspace takes the
  // selected picture, and undo brings it back.
  await img.click();
  await picture.getByTestId('doc-media-align-left').click();
  await page.keyboard.press('Backspace');
  await expect(picture).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(picture.locator('img')).toBeVisible();

  // A caption closed with Enter hands the keys back, and leaving the body
  // afterwards lets go of the picture.
  await picture.locator('img').click();
  await picture.getByTestId('doc-media-caption-button').click();
  await page.keyboard.type('Dusk');
  await page.keyboard.press('Enter');
  await expect(picture.getByTestId('doc-media-caption')).toHaveText('Dusk');
  expect(await page.evaluate(() => document.activeElement?.classList.contains('ProseMirror'))).toBe(true);
  // Closing the field is not leaving the body: the picture stays selected.
  await expect(knob).toBeVisible();
  await page.getByTestId('theme-toggle').click();
  await expect(knob).toHaveCount(0);
  await page.keyboard.press('Escape');

  // A right press beside the picture selects nothing.
  const frame = (await picture.locator('[data-media-frame]').boundingBox())!;
  await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2, { button: 'right' });
  await expect(knob).toHaveCount(0);

  // A click there, or on the caption, leaves the body with no focus and
  // nothing selected: a key typed afterwards writes nothing.
  const rowsNow = (): Promise<string[]> =>
    page.locator(`${EDITOR} .bn-block-content`).evaluateAll((all) =>
      all.map((row) => (row.getAttribute('data-content-type') === 'image' ? 'image' : (row.textContent ?? ''))),
    );
  const before = await rowsNow();
  const caption = picture.getByTestId('doc-media-caption');
  const captionBox = (await caption.boundingBox())!;
  for (const [x, y] of [
    [frame.x + frame.width + 40, frame.y + frame.height / 2],
    [captionBox.x + captionBox.width / 2, captionBox.y + captionBox.height / 2],
  ] as const) {
    await img.click();
    await expect(knob).toBeVisible();
    await page.mouse.click(x, y);
    await expect(knob).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.closest('.ProseMirror') ?? null)).toBeNull();
    await page.keyboard.type('z');
    expect(await rowsNow()).toEqual(before);
  }

  // The pointer on the caption does not frame the picture; on the picture it does.
  const outline = (): Promise<string> =>
    picture.locator('[data-media-frame]').evaluate((el) => getComputedStyle(el).outlineStyle);
  await page.mouse.move(captionBox.x + captionBox.width / 2, captionBox.y + captionBox.height / 2);
  expect(await outline()).toBe('none');
  await img.hover();
  expect(await outline()).toBe('solid');

  // Selected, then a click beside it, then a hand's press on it again: the
  // picture is selected and no caret shows anywhere while that happens or
  // after, on the line under it least of all.
  await img.click();
  await expect(knob).toBeVisible();
  await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2);
  await expect(knob).toHaveCount(0);
  await page.evaluate(() => {
    const carets: string[] = [];
    const w = window as unknown as { carets: string[]; drawnCaret: () => string | null };
    w.carets = carets;
    // A caret is drawn where the selection is collapsed in text that can be
    // typed into, in a colour that is not transparent.
    w.drawnCaret = (): string | null => {
      const selection = getSelection();
      const at = selection?.anchorNode;
      const holder = at instanceof Element ? at : at?.parentElement;
      if (
        document.activeElement?.closest('.ProseMirror') &&
        selection?.isCollapsed &&
        holder instanceof HTMLElement &&
        holder.isContentEditable &&
        getComputedStyle(holder).caretColor !== 'rgba(0, 0, 0, 0)'
      ) {
        return at?.textContent ?? '';
      }
      return null;
    };
    let frames = 0;
    const sample = (): void => {
      const caret = w.drawnCaret();
      if (caret !== null) carets.push(caret);
      frames += 1;
      if (frames < 60) requestAnimationFrame(sample);
    };
    sample();
  });
  const at = (await img.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await expect(knob).toBeVisible();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { carets: string[] }).carets)).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { drawnCaret: () => string | null }).drawnCaret())).toBeNull();
  await expect(knob).toBeVisible();
});

test('a click held with Cmd or Ctrl in a media row does what the plain click does (A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('omega');
  await page.keyboard.press('ArrowUp');
  await pastePicture(page, 'modifier.png');
  const picture = page.locator(IMAGE);
  const img = picture.locator('img');
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const knob = picture.locator('[data-testid="doc-media-resize-se"]');
  await img.click();
  await picture.getByTestId('doc-media-caption-button').click();
  await page.keyboard.type('Dusk');
  await page.keyboard.press('Enter');
  const rowsNow = (): Promise<string[]> =>
    page.locator(`${EDITOR} .bn-block-content`).evaluateAll((all) =>
      all.map((row) => (row.getAttribute('data-content-type') === 'image' ? 'image' : (row.textContent ?? ''))),
    );
  const before = await rowsNow();
  /**
   * Clicks at a point with the platform's node modifier held.
   * @param x - Where, across.
   * @param y - Where, down.
   */
  const modifierClick = async (x: number, y: number): Promise<void> => {
    await page.keyboard.down('ControlOrMeta');
    await page.mouse.click(x, y);
    await page.keyboard.up('ControlOrMeta');
  };

  // On the picture: it is selected, as a plain click selects it, selected or not.
  const at = (await img.boundingBox())!;
  for (let i = 0; i < 2; i += 1) {
    await modifierClick(at.x + at.width / 2, at.y + at.height / 2);
    await expect(knob).toBeVisible();
  }

  // Beside it and on its caption: nothing selected and no focus in the body.
  const frame = (await picture.locator('[data-media-frame]').boundingBox())!;
  const caption = (await picture.getByTestId('doc-media-caption').boundingBox())!;
  for (const [x, y] of [
    [frame.x + frame.width + 40, frame.y + frame.height / 2],
    [caption.x + caption.width / 2, caption.y + caption.height / 2],
  ] as const) {
    await img.click();
    await expect(knob).toBeVisible();
    await modifierClick(x, y);
    await expect(knob).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.closest('.ProseMirror') ?? null)).toBeNull();
    await page.keyboard.type('z');
    expect(await rowsNow()).toEqual(before);
  }
});

test('a picture shown full screen from its hover toolbar gives the caret back where it was when it closes (A10, A17)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('omega');
  await page.keyboard.press('ArrowUp');
  await pastePicture(page, 'hover-full.png');
  const picture = page.locator(IMAGE);
  const img = picture.locator('img');
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const knob = picture.locator('[data-testid="doc-media-resize-se"]');
  // The caret at the end of the line under the picture; the picture is not selected.
  await page.locator(`${EDITOR} .bn-block-content`).last().click();
  await page.keyboard.press('End');
  await expect(knob).toHaveCount(0);

  await img.hover();
  await picture.getByTestId('doc-media-fullscreen').click();
  await expect(page.getByTestId('doc-media-fullscreen-image')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-media-fullscreen-image')).toHaveCount(0);
  await page.mouse.move(5, 5);

  await expect(knob).toHaveCount(0);
  await page.keyboard.type('Z');
  const rows = await page.locator(`${EDITOR} .bn-block-content`).evaluateAll((all) =>
    all.map((row) => (row.getAttribute('data-content-type') === 'image' ? 'image' : (row.textContent ?? ''))),
  );
  expect(rows[rows.indexOf('image') + 1]).toBe('omegaZ');
});

for (const opening of ['toolbar', 'double click'] as const) {
  test(`a picture shown full screen from the ${opening} is selected again when it closes (A10, A17)`, async () => {
    await openFreshDocument(page);
    await page.keyboard.type('alpha');
    await page.keyboard.press('Enter');
    await page.keyboard.type('omega');
    await page.keyboard.press('ArrowUp');
    await pastePicture(page, 'full.png');
    const picture = page.locator(IMAGE);
    const img = picture.locator('img');
    await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    const knob = picture.locator('[data-testid="doc-media-resize-se"]');
    await img.click();
    await expect(knob).toBeVisible();
    const rowsNow = (): Promise<string[]> =>
      page.locator(`${EDITOR} .bn-block-content`).evaluateAll((all) =>
        all.map((row) => (row.getAttribute('data-content-type') === 'image' ? 'image' : (row.textContent ?? ''))),
      );
    const before = await rowsNow();

    if (opening === 'toolbar') await picture.getByTestId('doc-media-fullscreen').click();
    else await img.dblclick();
    await expect(page.getByTestId('doc-media-fullscreen-image')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('doc-media-fullscreen-image')).toHaveCount(0);
    await page.mouse.move(5, 5);

    await expect(knob).toBeVisible();
    // No caret is drawn, and a key typed now leaves the words as they were.
    expect(
      await page.evaluate(() => {
        const selection = getSelection();
        const at = selection?.anchorNode;
        const holder = at instanceof Element ? at : at?.parentElement;
        return (
          selection?.isCollapsed === true &&
          holder instanceof HTMLElement &&
          holder.isContentEditable &&
          getComputedStyle(holder).caretColor !== 'rgba(0, 0, 0, 0)'
        );
      }),
    ).toBe(false);
    await page.keyboard.type('z');
    expect(await rowsNow()).toEqual(before);
  });
}

test('a picture dragged by itself moves like a row dragged by its handle (A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('beta');
  await page.keyboard.press('ArrowUp');
  await pastePicture(page, 'move.png');
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const order = (): Promise<string[]> =>
    page.locator(`${EDITOR} .bn-block-content`).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-content-type') === 'image' ? 'image' : (row.textContent ?? '')),
    );
  expect(await order()).toEqual(['alpha', 'image', 'beta']);

  const from = (await img.boundingBox())!;
  const beta = (await page.locator(`${EDITOR} .bn-block-content`).filter({ hasText: 'beta' }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height - 10);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height, { steps: 4 });
  await page.mouse.move(beta.x + 40, beta.y + beta.height - 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(order).toEqual(['alpha', 'beta', 'image']);
  // The drag ended though the element it started from was redrawn: the
  // library's drag image is taken off the page again.
  await expect(page.locator('.bn-drag-preview')).toHaveCount(0);
});

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

test('a picture copied with the keyboard pastes back as the same picture (A10, A18)', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('omega');
  await page.keyboard.press('ArrowUp');
  await pastePicture(page, 'copy.png');
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const src = await img.getAttribute('src');

  await img.click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.locator(`${EDITOR} .bn-block-content`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+v');

  await expect(img).toHaveCount(2);
  expect(await img.nth(1).getAttribute('src')).toBe(src);
});

/**
 * Whether a caret is drawn anywhere: a collapsed selection in text that can be
 * typed into, in a colour that is not transparent.
 * @param p - The page.
 * @returns True when one is drawn.
 */
async function caretDrawn(p: Page): Promise<boolean> {
  return p.evaluate(() => {
    const selection = getSelection();
    const at = selection?.anchorNode;
    const holder = at instanceof Element ? at : at?.parentElement;
    return (
      document.activeElement?.closest('.ProseMirror') !== null &&
      selection?.isCollapsed === true &&
      holder instanceof HTMLElement &&
      holder.isContentEditable &&
      getComputedStyle(holder).caretColor !== 'rgba(0, 0, 0, 0)'
    );
  });
}

test('a media block stays selected while its own controls drawn outside the body have the keyboard (A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('omega');
  await page.keyboard.press('ArrowUp');
  const wav = wavBytes().toString('base64');
  await page.locator(EDITOR).evaluate((element, base64) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'own.wav', { type: 'audio/wav' }));
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, wav);
  const audio = page.locator(AUDIO);
  await expect(audio.getByTestId('waveform')).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const selected = (): Promise<string | null> => audio.getByTestId('doc-media-box').getAttribute('data-selected');

  // A press on the seek bar selects it, as a press on the waveform does.
  const first = (await page.locator(`${EDITOR} .bn-block-content`).first().boundingBox())!;
  await page.mouse.click(first.x + 4, first.y + first.height / 2);
  expect(await selected()).toBeNull();
  const seek = (await audio.getByTestId('seek').boundingBox())!;
  await page.mouse.click(seek.x + seek.width * 0.3, seek.y + seek.height / 2);
  await expect.poll(selected).toBe('true');

  // Its volume panel is its own control.
  await audio.getByTestId('volume-button').click();
  await expect(page.getByTestId('volume')).toBeVisible();
  await page.mouse.move(5, 5);
  expect(await selected()).toBe('true');
  await page.keyboard.press('Escape');
  expect(await selected()).toBe('true');

  // So is the menu of its row; closing it leaves the block selected and no caret.
  const row = (await audio.boundingBox())!;
  await page.mouse.move(row.x + 40, row.y + 11);
  await page.getByTestId('doc-block-handle').click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await selected()).toBe('true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await page.mouse.move(5, 5);
  expect(await selected()).toBe('true');
  expect(await caretDrawn(page)).toBe(false);

  // A menu outside the body still lets go of it.
  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('theme-popover')).toBeVisible();
  expect(await selected()).toBeNull();
  await page.keyboard.press('Escape');
});

test('in a document of media alone, a picture let go of is drawn as not selected (A10)', async () => {
  await openFreshDocument(page);
  await pastePicture(page, 'alone.png');
  const picture = page.locator(IMAGE);
  const img = picture.locator('img');
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  // Take the empty line under it away, through its row's menu.
  const rows = page.locator(`${EDITOR} .bn-block-content`);
  await expect(rows).toHaveCount(2);
  const line = (await rows.nth(1).boundingBox())!;
  await page.mouse.move(line.x + 40, line.y + 11);
  await page.getByTestId('doc-block-plus').click();
  await page.getByTestId('doc-block-plus-delete').click();
  await expect(rows).toHaveCount(1);
  const selected = (): Promise<string | null> => picture.getByTestId('doc-media-box').getAttribute('data-selected');

  await img.click();
  expect(await selected()).toBe('true');
  const frame = (await picture.locator('[data-media-frame]').boundingBox())!;
  await page.mouse.click(frame.x + frame.width + 60, frame.y + frame.height / 2);
  expect(await selected()).toBeNull();
  expect(await page.evaluate(() => document.activeElement?.closest('.ProseMirror') ?? null)).toBeNull();

  await img.click();
  expect(await selected()).toBe('true');
  await page.getByTestId('theme-toggle').click();
  await expect(page.getByTestId('theme-popover')).toBeVisible();
  expect(await selected()).toBeNull();
  await page.keyboard.press('Escape');
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
