// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Node download E2E (#2108) — the half no unit test can reach.
 *
 * The unit suite pins which nodes offer the item and what address it hands
 * over. What it cannot answer is whether the browser treats that address as
 * a download at all: `<a download>` is ignored the moment the final URL is
 * cross-origin, so the only thing that makes this a download is the
 * `Content-Disposition: attachment` the ingest Worker sends. If that header
 * were missing the browser would navigate to the image instead and no
 * `download` event would ever fire — which is exactly what this asserts (A11).
 *
 * The bytes are uploaded by the run itself, because the address has to be a
 * real object in our own bucket: the server refuses anything else, and a data
 * URI never reaches the Worker.
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 *
 * It also needs the ingest Worker this checkout's `INGEST_BASE_URL` names to
 * be serving `/download/{key}`. A Worker deployed before that route existed
 * answers 404, the browser navigates to it, and no download ever starts —
 * measured 2026-09-18 against `breatic-ingest.orime.workers.dev`, where a
 * `POST /download/probe` came back 404 rather than the 405 the route answers.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

let page: Page;
let spaceId = '';

/** A 1x1 PNG; random bytes are appended so each run stores a new object. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  spaceId = await createSpace(page, 'canvas', `node-download-e2e-${Date.now()}`);
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await page?.close();
  spaceId = '';
});

/**
 * Drop one file onto the canvas pane.
 *
 * Built inside the page so the `DataTransfer` belongs to the realm the
 * listener reads it in (same shape as `canvas-upload-ingest.spec.ts`).
 * @param bytes - The file's contents.
 */
async function dropPng(bytes: Buffer): Promise<void> {
  await page.evaluate(async (encoded: string) => {
    const binary = atob(encoded);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    const file = new File([buffer], 'downloadable.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const pane = document.querySelector('.react-flow__pane');
    if (pane === null) throw new Error('no canvas pane to drop onto');
    const rect = pane.getBoundingClientRect();
    const at = {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true,
    };
    pane.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: transfer }));
    pane.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: transfer }));
  }, bytes.toString('base64'));
}

// The bytes go to R2 through the ingest Worker and come back from the
// address the server registered, so this asks for both services.
test('the menu hands the stored file to the browser as a download @needs-ingest @needs-storage', async () => {
  // An upload to R2 and back outlasts the config's 30s budget on its own.
  test.setTimeout(120_000);
  const uploaded = Buffer.concat([TINY_PNG, randomBytes(16)]);
  await dropPng(uploaded);

  // The drop makes an empty node first; the picture arrives when the server
  // has registered the bytes. Waiting for the node separates "the drop never
  // landed" from "the upload is still running".
  await expect(page.locator('.react-flow__node')).toHaveCount(1, {
    timeout: 20_000,
  });

  // The Space starts empty, so the one image that appears is this upload's,
  // and it carries the address the server registered.
  const nodeImage = page.locator('.react-flow__node img');
  await expect(nodeImage).toHaveCount(1, { timeout: 30_000 });
  const stored = await nodeImage.evaluate(
    (img) => (img as HTMLImageElement).src,
  );
  expect(stored).toMatch(/^https?:\/\//);

  await page
    .locator('.react-flow__node')
    .first()
    .locator('[data-testid=image-node]')
    .click({ button: 'right' });

  // A navigation instead of a download would leave this waiting: nothing on
  // our side can force the browser's hand, only the Worker's header does.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('node-menu-download').click(),
  ]);

  // A7: the name is the last segment of the object's key, which is also the
  // last segment of the address the node holds.
  const keyTail = decodeURIComponent(
    new URL(stored).pathname.split('/').pop() ?? '',
  );
  expect(download.suggestedFilename()).toBe(keyTail);

  // And it is that object, not an error page wearing its name.
  const saved = await download.path();
  expect(readFileSync(saved).equals(uploaded)).toBe(true);
});
