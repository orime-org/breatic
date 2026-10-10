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

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { blankPoint, bodySelection } from '../helpers/document-body';
import { pressAndSettle } from '../helpers/editor-keys';
import { wavBytes } from '../helpers/media-bytes';
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

/** A media block type. */
type MediaKind = 'image' | 'video' | 'audio';

/**
 * One attribute of each media block in the body, read from the document;
 * what the page shows of a picture may be its preview.
 * @param p - The page.
 * @param attr - `url` for the stored address, `name` for the file name.
 * @param kinds - Which blocks.
 * @returns One per block, in order.
 */
async function mediaAttr(
  p: Page,
  attr: 'url' | 'name',
  kinds: readonly MediaKind[] = ['image', 'video', 'audio'],
): Promise<string[]> {
  return p.evaluate(
    ([selector, key, wanted]) => {
      const el = document.querySelector(selector) as unknown as {
        editor: {
          state: {
            doc: {
              descendants: (f: (node: { type: { name: string }; attrs: Record<string, string | undefined> }) => void) => void;
            };
          };
        };
      };
      const values: string[] = [];
      el.editor.state.doc.descendants((node) => {
        if ((wanted as readonly string[]).includes(node.type.name)) values.push(node.attrs[key] ?? '');
      });
      return values;
    },
    [EDITOR, attr, kinds] as const,
  );
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

test('the grip menu inserts the picked files below its row, side by side, one empty line after the last (A1, A4)', async () => {
  await openFreshDocument(page);
  await page.locator(EDITOR).click();
  await page.keyboard.type('a row to act on');
  await page.locator(`${EDITOR} .bn-block-content`).first().hover();
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('doc-block-insert-image').click();
  await (
    await chooser
  ).setFiles([
    { name: 'g1.png', mimeType: 'image/png', buffer: await pngBytes(page, 120, 80) },
    { name: 'g2.png', mimeType: 'image/png', buffer: await pngBytes(page, 121, 80) },
    { name: 'g3.png', mimeType: 'image/png', buffer: await pngBytes(page, 122, 80) },
  ]);

  await expect(page.locator(`${IMAGE} img`)).toHaveCount(3, { timeout: UPLOAD_TIMEOUT });
  expect(await types(page)).toEqual(['paragraph', 'image', 'image', 'image', 'paragraph']);
  expect(await mediaAttr(page, 'name')).toEqual(['g1.png', 'g2.png', 'g3.png']);
  await expect(page.locator(`${EDITOR} p`).first()).toHaveText('a row to act on');
});

test('three files dropped together land in the order they came in, at the line shown during the drag (A2)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('Above, a line long enough that the middle of it is words');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Below');
  const first = (await pngBytes(page, 320, 180)).toString('base64');
  const third = (await pngBytes(page, 200, 100)).toString('base64');
  const wav = wavBytes().toString('base64');

  // Over the middle of the words, the line stands between the blocks, where the files land.
  const line = await page.locator(`${EDITOR} .bn-block-content >> nth=0`).evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(4)], 'x.png', { type: 'image/png' }));
    const box = element.getBoundingClientRect();
    const at = { clientX: box.left + box.width / 2, clientY: box.bottom - 2 };
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
    const cursor = document.querySelector('.prosemirror-dropcursor-block, .prosemirror-dropcursor-inline');
    const top = cursor?.getBoundingClientRect().top ?? NaN;
    element.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: transfer, ...at }));
    return { kind: cursor?.className ?? null, top, rowBottom: box.bottom };
  });
  expect(line.kind).toContain('prosemirror-dropcursor-block');
  expect(Math.abs(line.top - line.rowBottom)).toBeLessThan(8);

  // The first file is held back so it finishes last.
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route('**/api/v1/assets/upload-ticket', async (route) => {
    if ((route.request().postData() ?? '').includes('one.png')) await held;
    await route.continue();
  });
  await dropFiles(page, `${EDITOR} .bn-block-content >> nth=0`, [
    { name: 'one.png', type: 'image/png', base64: first },
    { name: 'two.wav', type: 'audio/wav', base64: wav },
    { name: 'three.png', type: 'image/png', base64: third },
  ]);

  await expect(page.locator(PLACEHOLDER)).toHaveCount(3);
  await expect(page.locator(AUDIO)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await expect(page.locator(IMAGE)).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  // The two that finished stand where they belong, the first one's place kept.
  await expect(page.locator(PLACEHOLDER)).toHaveCount(1);
  release();
  await expect(page.locator(IMAGE)).toHaveCount(2, { timeout: UPLOAD_TIMEOUT });
  expect(await types(page)).toEqual(['paragraph', 'image', 'audio', 'image', 'paragraph']);
  expect(await mediaAttr(page, 'name')).toEqual(['one.png', 'two.wav', 'three.png']);
});

test('a pasted picture lands under the caret\'s line (A3)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('Line');

  await pasteFile(page, await pngBytes(page, 200, 120), 'pasted.png', 'image/png');

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

/** What each download smoke uploads. */
const DOWNLOADS: Record<MediaKind, { name: string; mimeType: string; bytes: (p: Page) => Promise<Buffer> }> = {
  image: { name: 'keep.png', mimeType: 'image/png', bytes: (p) => pngBytes(p, 160, 90) },
  video: {
    name: 'keep.mp4',
    mimeType: 'video/mp4',
    bytes: () => Promise.resolve(readFileSync(resolve(__dirname, '../fixtures/media-history.mp4'))),
  },
  audio: { name: 'keep.wav', mimeType: 'audio/wav', bytes: () => Promise.resolve(wavBytes()) },
};

for (const kind of ['image', 'video', 'audio'] as const) {
  test(`the toolbar hands a stored ${kind} to the browser as a download (A19) @needs-ingest @needs-storage`, async () => {
    await openFreshDocument(page);
    const { bytes: make, ...file } = DOWNLOADS[kind];
    const bytes = await make(page);
    await pickFromPlus(page, kind, { ...file, buffer: bytes });
    const block = page.locator(`${EDITOR} [data-content-type="${kind}"]`);
    const frame = block.locator('[data-media-frame]');
    await expect(frame).toBeVisible({ timeout: UPLOAD_TIMEOUT });
    const [stored] = await mediaAttr(page, 'url', [kind]);

    // The first block's bar sits on the media's top, so the pointer rests low.
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height - 4);
    // The same path the canvas node menu takes: a navigation instead of a
    // download would leave this waiting.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.getByTestId('doc-media-download').click(),
    ]);

    expect(download.suggestedFilename()).toBe(
      decodeURIComponent(new URL(stored!).pathname.split('/').pop() ?? ''),
    );
    expect(readFileSync(await download.path()).equals(bytes)).toBe(true);
  });
}

test('the toolbar sits above a picture with lines above it (A9)', async () => {
  await openFreshDocument(page);
  for (let line = 0; line < 4; line += 1) {
    await page.keyboard.type(`Line ${line}`);
    await page.keyboard.press('Enter');
  }
  await pasteFile(page, await pngBytes(page, 300, 160), 'mid.png', 'image/png');
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
  await pasteFile(page, await pngBytes(page, 300, 400), 'tall.png', 'image/png');
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
  // Each knob takes a press on 24px around its corner (WCAG 2.5.8) and shows an 8px dot.
  const shown = (await frame.boundingBox())!;
  const corners = {
    nw: [shown.x, shown.y],
    ne: [shown.x + shown.width, shown.y],
    sw: [shown.x, shown.y + shown.height],
    se: [shown.x + shown.width, shown.y + shown.height],
  } as const;
  for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
    const knob = page.getByTestId(`doc-media-resize-${corner}`);
    await expect(knob).toBeVisible();
    const box = (await knob.boundingBox())!;
    expect([box.width, box.height]).toEqual([24, 24]);
    expect(Math.abs(box.x + 12 - corners[corner][0])).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + 12 - corners[corner][1])).toBeLessThanOrEqual(1);
    const dot = (await knob.locator('[data-media-knob]').boundingBox())!;
    expect([dot.width, dot.height]).toEqual([8, 8]);
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
    await pasteFile(page, await pngBytes(page, 200, 120), name, 'image/png');
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
  // The size read off the file reaches the player, which holds it while loading (A23).
  expect([await video.getAttribute('width'), await video.getAttribute('height')]).toEqual(['64', '48']);
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

test('a picture that is the first block takes its width from any corner (A8)', async () => {
  await openFreshDocument(page);
  await pickFromPlus(page, 'image', { name: 'first.png', mimeType: 'image/png', buffer: await pngBytes(page, 600, 300) });
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  expect(await types(page)).toEqual(['image', 'paragraph']);

  for (const [corner, by] of [['se', -100], ['ne', -60]] as const) {
    await img.click();
    const knob = page.getByTestId(`doc-media-resize-${corner}`);
    const before = (await img.boundingBox())!.width;
    const box = (await knob.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + by, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await img.boundingBox())!.width).toBeLessThan(before - 20);
    await expect(page.locator(IMAGE)).toHaveAttribute('data-preview-width', String(Math.round((await img.boundingBox())!.width)));
  }
});

test('the keys on a player button are the button\'s: Space and Enter play and pause, and the document stays as it is (A7, A10)', async () => {
  await openFreshDocument(page);
  await pickFromPlus(page, 'video', {
    name: 'keys.mp4',
    mimeType: 'video/mp4',
    buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
  });
  const video = page.locator(`${VIDEO} video`);
  await expect(video).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const before = await types(page);
  const paused = (): Promise<boolean> => video.evaluate((v: HTMLVideoElement) => v.paused);
  const play = page.locator(`${VIDEO} [data-testid="play-toggle"]`);

  await play.click();
  await expect.poll(paused).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(paused).toBe(true);
  await page.keyboard.press('Enter');
  await expect.poll(paused).toBe(false);
  await page.keyboard.press('Enter');
  await expect.poll(paused).toBe(true);
  expect(await types(page)).toEqual(before);
  await expect(page.locator(`${VIDEO} [data-testid="doc-media-box"]`)).toHaveAttribute('data-selected', 'true');
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
 * Pastes a file into the body, the way the system clipboard hands one over.
 * @param p - The page.
 * @param bytes - The file's bytes.
 * @param name - The file's name.
 * @param type - Its MIME type.
 */
async function pasteFile(p: Page, bytes: Buffer, name: string, type: string): Promise<void> {
  await p.locator(EDITOR).evaluate(
    (element, [base64, fileName, mime]) => {
      const transfer = new DataTransfer();
      const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      transfer.items.add(new File([raw], fileName, { type: mime }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    },
    [bytes.toString('base64'), name, type] as const,
  );
}

/**
 * Pastes a fresh picture under the caret's line.
 * @param p - The page.
 * @param name - The file's name.
 */
async function pastePicture(p: Page, name: string): Promise<void> {
  await pasteFile(p, await pngBytes(p, 220, 120), name, 'image/png');
}

test('Shift+click on a picture while the body is let go selects the picture and leaves the old words out (A20)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('hello world');
  await pastePicture(page, 'shift.png');
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await page.locator(`${EDITOR} p`).first().click();
  await pressAndSettle(page, process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home');
  for (let i = 0; i < 5; i += 1) await pressAndSettle(page, 'Shift+ArrowRight');
  const { x, y } = await blankPoint(page);
  await page.mouse.click(x, y);
  await expect(page.locator(EDITOR)).not.toHaveAttribute('data-body-holds', /.*/);

  await img.click({ modifiers: ['Shift'] });

  await expect.poll(() => bodySelection(page)).toEqual({ kind: '_NodeSelection:image', text: '' });
});

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

  // A right press beside the picture selects nothing, and lets go of the
  // picture when it was selected, as a left one does.
  const frame = (await picture.locator('[data-media-frame]').boundingBox())!;
  await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2, { button: 'right' });
  await expect(knob).toHaveCount(0);
  await img.click();
  await expect(knob).toBeVisible();
  await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2, { button: 'right' });
  await expect(knob).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.closest('.ProseMirror') ?? null)).toBeNull();
  // A middle press anywhere in the body is the browser's own (inner#1127
  // A20): it moves neither the focus nor the selection.
  await img.click();
  await expect(knob).toBeVisible();
  await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2, { button: 'middle' });
  await expect(knob).toBeVisible();

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

  // When the pointer moves a few pixels before it is let go, the selected
  // picture's row is not dragged: a drag from blank space selects from the
  // press point and gives the body the focus (inner#1127 A20).
  for (const drift of [6, 20]) {
    await img.click();
    await expect(knob).toBeVisible();
    const x = frame.x + frame.width + 40;
    const y = frame.y + frame.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + drift, y, { steps: 3 });
    await page.mouse.up();
    await expect(knob).toHaveCount(0);
    expect(await rowsNow()).toEqual(before);
    await expect(page.locator(EDITOR)).toHaveAttribute('data-body-holds', /.*/);
  }

  // The pointer on the caption does not frame the picture; on the picture it
  // does. From a body that let go, so no selection frames it first: the drag
  // above left one running across the picture.
  await page.mouse.click(frame.x + frame.width + 40, frame.y + frame.height / 2);
  await expect(page.locator(EDITOR)).not.toHaveAttribute('data-body-holds', /.*/);
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

test('a right or middle press on a picture selects it as it lands, with no caret drawn while it is held (A10)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.type('omega');
  await page.keyboard.press('ArrowUp');
  await pastePicture(page, 'press.png');
  const picture = page.locator(IMAGE);
  const img = picture.locator('img');
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const knob = picture.locator('[data-testid="doc-media-resize-se"]');

  for (const button of ['right', 'middle'] as const) {
    // The body without the keyboard, the caret it had kept on the line above.
    await page.getByTestId('theme-toggle').click();
    await page.keyboard.press('Escape');
    await expect(knob).toHaveCount(0);
    const at = (await img.boundingBox())!;
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down({ button });
    const drawn: boolean[] = [];
    for (let i = 0; i < 10; i += 1) {
      drawn.push(await caretDrawn(page));
      await page.waitForTimeout(15);
    }
    await expect(knob).toBeVisible();
    await page.mouse.up({ button });
    expect(drawn).not.toContain(true);
    await page.keyboard.press('Escape');
  }
});

for (const kind of ['image', 'video', 'audio'] as const) {
  test(`a press that closes the grip menu leaves the selected ${kind} selected (A20)`, async () => {
    await openFreshDocument(page);
    await page.keyboard.type('alpha');
    const file = DOWNLOADS[kind];
    await pasteFile(page, await file.bytes(page), file.name, file.mimeType);
    const frame = page.locator(`${EDITOR} [data-content-type="${kind}"] [data-testid="doc-media-box"]`);
    await expect(frame.locator(kind === 'image' ? 'img' : kind)).toBeAttached({ timeout: UPLOAD_TIMEOUT });
    await expect(frame).toBeVisible();
    const box = (await frame.boundingBox())!;
    // The far corner of the media, away from the menu and the player's controls.
    const corner = { x: box.x + box.width - 12, y: box.y + 12 };
    await page.mouse.click(corner.x, corner.y);
    await expect.poll(() => bodySelection(page)).toEqual({ kind: `_NodeSelection:${kind}`, text: '' });

    await page.mouse.move(box.x - 30, box.y + 10);
    await page.getByTestId('doc-block-handle').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.mouse.click(corner.x, corner.y);

    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect.poll(() => bodySelection(page)).toEqual({ kind: `_NodeSelection:${kind}`, text: '' });
  });
}

test('a picture shown full screen from its hover toolbar is selected, and stays selected when it closes (A17, A20)', async () => {
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

  await expect(knob).toBeVisible();
  await expect.poll(() => bodySelection(page)).toEqual({ kind: '_NodeSelection:image', text: '' });
});

for (const [opening, closing] of [
  ['toolbar', 'Escape'],
  ['double click', 'Escape'],
  ['toolbar', 'a press on the overlay'],
] as const) {
  test(`a picture shown full screen from the ${opening} is selected again when it closes on ${closing} (A10, A17)`, async () => {
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
    if (closing === 'Escape') await page.keyboard.press('Escape');
    else await page.mouse.click(10, 10);
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
  // Closing the Space's tab is refused while the upload is in flight.
  const spaceId = createdSpaceIds[createdSpaceIds.length - 1]!;
  const tab = page.getByTestId(`space-tab-${spaceId}`);
  const close = page.getByTestId(`space-tab-close-${spaceId}`);
  await tab.hover();
  await close.click();
  await expect(page.getByText(/still in progress/)).toBeVisible();
  await expect(tab).toBeVisible();

  release();
  await expect(page.locator(`${IMAGE} img`)).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  expect(await leaveIsHeld()).toBe(false);
  await tab.hover();
  await close.click();
  await expect(tab).toHaveCount(0);
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
  const [stored] = await mediaAttr(page, 'url', ['image']);

  await img.click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.locator(`${EDITOR} .bn-block-content`).last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+v');

  await expect(img).toHaveCount(2);
  expect(await mediaAttr(page, 'url', ['image'])).toEqual([stored, stored]);
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
  await pasteFile(page, wavBytes(), 'own.wav', 'audio/wav');
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

test('a picture keeps its size under a skeleton while it loads, then shows the original when the preview is too narrow (A23)', async () => {
  await openFreshDocument(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route(/\.(png|webp)(\?.*)?$/, async (route) => {
    if (route.request().resourceType() === 'image') await held;
    await route.continue();
  });
  // A preview that loads, so the original can only come from the width rule.
  // The ingest cuts previews 576 wide and rounds the height, so a 1601x901
  // original gets a 576x324 preview, a shade off the original's shape.
  const preview = await pngBytes(page, 576, 324);
  await page.route(/\.preview\.webp$/, async (route) => {
    await held;
    await route.fulfill({ status: 200, contentType: 'image/webp', body: preview });
  });
  await pickFromPlus(page, 'image', {
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: await pngBytes(page, 1601, 901),
  });

  const img = page.locator(`${IMAGE} img`);
  await expect(img).toHaveCount(1, { timeout: UPLOAD_TIMEOUT });
  expect(await img.getAttribute('width')).toBe('1601');
  expect(await img.getAttribute('height')).toBe('901');
  await expect(page.locator(`${IMAGE} [data-testid="doc-media-skeleton"]`)).toBeVisible();
  const next = page.locator(`${EDITOR} .bn-block-content >> nth=1`);
  const nextTop = (await next.boundingBox())!.y;
  const box = await img.boundingBox();
  expect(box!.height).toBeGreaterThan(0);
  expect(Math.abs(box!.width / box!.height - 1601 / 901)).toBeLessThan(0.02);
  // Every frame from here on records where the next block sits.
  await next.evaluate((element) => {
    const tops: number[] = [];
    (window as unknown as { nextTops: number[] }).nextTops = tops;
    const sample = (): void => {
      tops.push(element.getBoundingClientRect().top);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  release();
  await expect(page.locator(`${IMAGE} [data-testid="doc-media-skeleton"]`)).toHaveCount(0);
  await expect.poll(() => img.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1601);
  expect(await img.getAttribute('src')).not.toContain('.preview.webp');
  // Loading changed nothing below it, the preview's frames included (A23).
  expect((await next.boundingBox())!.y).toBe(nextTop);
  const tops = await page.evaluate(() => (window as unknown as { nextTops: number[] }).nextTops);
  expect(new Set(tops)).toEqual(new Set([nextTop]));
});

test('a video keeps its size under a skeleton until its first frame, and nothing below it moves (A23)', async () => {
  await openFreshDocument(page);
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route(/\.mp4(\?.*)?$/, async (route) => {
    if (route.request().resourceType() === 'media') await held;
    await route.continue();
  });
  await pickFromPlus(page, 'video', {
    name: 'held.mp4',
    mimeType: 'video/mp4',
    buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
  });

  const skeleton = page.locator(`${VIDEO} [data-testid="media-skeleton"]`);
  await expect(skeleton).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  const next = page.locator(`${EDITOR} .bn-block-content >> nth=1`);
  const nextTop = (await next.boundingBox())!.y;

  release();
  await expect(skeleton).toHaveCount(0, { timeout: 30_000 });
  expect((await next.boundingBox())!.y).toBe(nextTop);
});

test('a picture shown no wider than its preview is drawn from the preview (A23)', async () => {
  await openFreshDocument(page);
  // This worktree uploads through the deployed ingest Worker, which does not
  // cut previews yet; the page's side of the rule is what is checked here.
  const preview = await pngBytes(page, 400, 300);
  await page.route(/\.preview\.webp$/, (route) =>
    route.fulfill({ status: 200, contentType: 'image/webp', body: preview }),
  );
  await pickFromPlus(page, 'image', {
    name: 'small.png',
    mimeType: 'image/png',
    buffer: await pngBytes(page, 400, 300),
  });

  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await expect.poll(() => img.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(400);
  expect(await img.getAttribute('src')).toMatch(/\.png\.preview\.webp$/);
  await expect(page.locator(`${IMAGE} [data-testid="doc-media-skeleton"]`)).toHaveCount(0);
});

test('a picture and its caption show in a second client opening the document (A13)', async ({ browser }) => {
  await openFreshDocument(page);
  const home = (await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-testid'))!;
  await pastePicture(page, 'shared.png');
  const img = page.locator(`${IMAGE} img`);
  await expect(img).toBeVisible({ timeout: UPLOAD_TIMEOUT });
  await img.click();
  await page.getByTestId('doc-media-caption-button').click();
  await page.getByTestId('doc-media-caption-input').fill('Shared');
  await page.keyboard.press('Enter');
  await expect(page.locator(`${IMAGE} [data-testid="doc-media-caption"]`)).toHaveText('Shared');

  const second = await browser.newContext({ storageState: STATE_FILE.A, viewport: { width: 1680, height: 950 } });
  const peer = await second.newPage();
  try {
    await peer.goto(page.url());
    await peer.getByTestId(home).click();
    const seen = peer.locator(`${IMAGE} img`);
    await expect(seen).toBeVisible({ timeout: 30_000 });
    expect([await seen.getAttribute('width'), await seen.getAttribute('height')]).toEqual(['220', '120']);
    await expect(peer.locator(`${IMAGE} [data-testid="doc-media-caption"]`)).toHaveText('Shared');
    await expect.poll(() => seen.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(220);
  } finally {
    await second.close();
  }
});
