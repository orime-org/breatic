// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The node menu's Download hands the stored file to the browser's own
 * download list (#2108, inner#1335).
 *
 * The menu opens the asset's own public URL with `download=1`. The resource
 * domain answers that query with `Content-Disposition: attachment`, and that
 * header is the only thing that makes the answer a download: `<a download>`
 * is ignored once the URL is cross-origin. Without it the browser opens the
 * picture and no `download` event fires — which is what this waits for.
 *
 * The bytes are uploaded by the run itself, so the address is a real object
 * in our own bucket.
 *
 * Needs a running dev stack (`pnpm dev`):
 *
 *   pnpm --filter @breatic/web test:smoke:all
 *
 * It also needs this checkout's `UPLOAD_BASE_URL` on a domain that carries
 * the `download` rule (resource-dev.breatic.cc). An `r2.dev` address cannot
 * carry it, and there the browser opens the file by design; the case checks
 * the host first so that reads as a setup problem.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace, VISIBLE_SPACE } from '../helpers/space';

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
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
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
  await page.evaluate(async ([encoded, space]: [string, string]) => {
    const binary = atob(encoded);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    const file = new File([buffer], 'downloadable.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const pane = document.querySelector(`${space} .react-flow__pane`);
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
  }, [bytes.toString('base64'), VISIBLE_SPACE] as [string, string]);
}

// The bytes go to R2 through the ingest Worker and come back from the
// address the server registered, so this asks for both services.
test('the menu hands the stored file to the browser as a download @needs-ingest @needs-storage', async () => {
  const uploaded = Buffer.concat([TINY_PNG, randomBytes(16)]);
  await dropPng(uploaded);

  // The drop makes an empty node first; the picture arrives when the server
  // has registered the bytes. Waiting for the node separates "the drop never
  // landed" from "the upload is still running".
  await expect(visibleSpace(page).locator('.react-flow__node')).toHaveCount(1, {
    timeout: 20_000,
  });

  // The Space starts empty, so the one picture that appears is this upload's.
  // Zoomed past the preview, the node lays the original over it as a second
  // img; the node's own picture is the one with this test id.
  const nodeImage = visibleSpace(page).getByTestId('image-node-img');
  await expect(nodeImage).toHaveCount(1, { timeout: 30_000 });
  const shown = new URL(await nodeImage.evaluate((img) => (img as HTMLImageElement).src));
  expect(
    shown.hostname.endsWith('.r2.dev'),
    `UPLOAD_BASE_URL is on ${shown.hostname}, which cannot carry the download rule`,
  ).toBe(false);

  await page
    .locator('.react-flow__node')
    .first()
    .locator('[data-testid=image-node]')
    .click({ button: 'right' });

  // A navigation instead of a download would leave this waiting: only the
  // resource domain's header makes the answer a download.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('node-menu-download').click(),
  ]);

  // The browser went straight to the stored object, asking for the download.
  const fetched = new URL(download.url());
  expect(fetched.host).toBe(shown.host);
  expect(fetched.search).toBe('?download=1');

  // A7: the name is the last segment of the object's key.
  const keyTail = decodeURIComponent(fetched.pathname.split('/').pop() ?? '');
  expect(download.suggestedFilename()).toBe(keyTail);

  // And it is that object, not an error page wearing its name.
  const saved = await download.path();
  expect(readFileSync(saved).equals(uploaded)).toBe(true);
});
