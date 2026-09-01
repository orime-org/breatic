// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas upload through the ingest Worker E2E (#173) — the half no unit test
 * reaches.
 *
 * Two things live here because nothing below a real browser can answer them.
 * The first is A1: a picked file's bytes travel to the Worker, the server
 * registers them, and the URL that lands on the node survives a reload. The
 * second is what happens when the transfer dies partway — the node's failure
 * is the browser's to write once its own retries are spent (design §5.6,
 * §6.6), and `failUploadNode` lives inside a `useCallback` no unit test can
 * call.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { randomBytes } from 'node:crypto';

import { test, expect, type BrowserContext, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let spaceId = '';

/** A 1x1 PNG, small enough to be one part and to decode with no network. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Sign a page in and leave it wherever the app lands after login.
 * @param target - A fresh page.
 * @throws {Error} When the sign-in never leaves the login route.
 */
async function signIn(target: Page): Promise<void> {
  await target.goto('/login');
  await target.locator('#login-email').fill(email as string);
  await target.locator('#login-password').fill(password as string);
  await target.locator('form button[type="submit"]').click();
  await target.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Drop one file onto the canvas the way a user does.
 *
 * The drop is built in the page so the `DataTransfer` belongs to the same
 * realm the listener reads it in.
 * @param target - A page with a canvas Space open.
 * @param name - The file name to drop under.
 * @param type - The MIME type the browser would report.
 * @param bytes - The file's contents.
 */
async function dropFile(
  target: Page,
  name: string,
  type: string,
  bytes: Buffer,
): Promise<void> {
  await target.evaluate(
    async ([fileName, mime, encoded]: [string, string, string]) => {
      const binary = atob(encoded);
      const buffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
      const file = new File([buffer], fileName, { type: mime });
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
    },
    [name, type, bytes.toString('base64')] as [string, string, string],
  );
}

/** Every image node's `src` currently on the canvas. */
async function imageSources(target: Page): Promise<string[]> {
  return target.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node img')].map(
      (img) => (img as HTMLImageElement).src,
    ),
  );
}

test.beforeAll(async ({ browser }) => {
  // A hook keeps the config's budget until it raises its own, and seeding a
  // Space behind a sign-in outlasts 30s.
  test.setTimeout(120_000);
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page);

  // Reuse an existing Project: this spec is about uploads, and minting one per
  // run burns the tier's projects-per-studio allowance.
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });
  spaceId = await createSpace(page, 'canvas', `upload-${Date.now()}`);
});

test.afterAll(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await context.close();
});

// A1: the bytes reach R2 through the Worker, and the URL the server wrote is
// the one the node keeps — which is what a reload proves.
test('a dropped image lands on a node with a URL that survives a reload', async () => {
  await dropFile(page, 'tiny.png', 'image/png', TINY_PNG);

  // The Space starts empty, so the one source that appears is this upload's.
  await expect
    .poll(async () => (await imageSources(page)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const [landed] = await imageSources(page);
  expect(landed).toMatch(/^https?:\/\//);

  // A reload reads the node back out of Yjs, so what survives it is what the
  // server wrote rather than anything this session held. The tab strip opens
  // on the project's first Space, so this one is picked again by hand.
  await page.reload();
  await page.getByTestId(`space-tab-name-${spaceId}`).click();
  await expect
    .poll(async () => imageSources(page), { timeout: 30_000 })
    .toContain(landed);
});

// Design §5.6 and the §6.6 table put this write on the browser: once its own
// retries are spent the node fails there and then, keeps its Retry stash, and
// says so in the language of the person who tried.
test('a transfer that dies leaves the node failed and says so', async () => {
  await page.route('**/uploads**', (route) => route.abort('connectionfailed'));

  // Bytes no earlier run has stored: an identical file hits dedup at the
  // ticket, which answers with the existing URL and sends nothing to abort.
  await dropFile(
    page,
    'doomed.png',
    'image/png',
    Buffer.concat([TINY_PNG, randomBytes(16)]),
  );

  await expect(page.getByText(/Upload failed: doomed\.png/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[data-sonner-toast]')).toBeVisible({
    timeout: 5_000,
  });

  await page.unroute('**/uploads**');
});
