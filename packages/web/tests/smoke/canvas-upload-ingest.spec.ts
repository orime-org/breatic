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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type BrowserContext, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let spaceId = '';
let workDir = '';

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

/**
 * Build a video large enough to be sent in several parts.
 *
 * `testsrc` is a synthetic pattern that compresses to almost nothing, so the
 * clip is looped until it clears the 8 MiB part size several times over —
 * which is the whole point of this file, since one part exercises none of the
 * Durable Object's accounting.
 *
 * The comment tag carries random bytes because ffmpeg's output is otherwise
 * deterministic: an identical file hashes the same, and the ticket answers the
 * second run with the first run's asset without a byte moving — which is the
 * dedup path, not the one this case is here to exercise.
 * @param dir - Where to leave the file.
 * @returns The path to the built video.
 * @throws {Error} When ffmpeg is not on PATH or produced nothing usable.
 */
function buildMultipartVideo(dir: string): string {
  const seed = join(dir, 'seed.mp4');
  const out = join(dir, 'multipart.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
    '-t', '25', '-pix_fmt', 'yuv420p', '-b:v', '6M', seed,
  ]);
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-stream_loop', '11', '-i', seed, '-c', 'copy',
    '-metadata', `comment=${randomBytes(16).toString('hex')}`, out,
  ]);
  return out;
}

/** Every video node's `src` currently on the canvas. */
async function videoSources(target: Page): Promise<string[]> {
  return target.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node video')].map(
      (v) => (v as HTMLVideoElement).src,
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
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

// A1: the bytes reach R2 through the Worker, and the URL the server wrote is
// the one the node keeps — which is what a reload proves.
test('a dropped image lands on a node with a URL that survives a reload', async () => {
  // Bytes no earlier run has stored. A fixed payload would hit dedup at the
  // ticket from the second run onwards, and the answer to that never reaches
  // the Worker — which is the half this case exists to prove.
  await dropFile(
    page,
    'tiny.png',
    'image/png',
    Buffer.concat([TINY_PNG, randomBytes(16)]),
  );

  // The Space starts empty, so the one source that appears is this upload's.
  await expect
    .poll(async () => (await imageSources(page)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const [landed] = await imageSources(page);
  expect(landed).toMatch(/^https?:\/\//);

  // A reload reads the node back out of Yjs, so what survives it is what the
  // server wrote rather than anything this session held. Which Space the strip
  // opens on is a local choice, and until it has been read back the strip
  // falls back to the first tab — so a click sent before that lands is undone
  // by the fallback. Waiting for a tab to be marked chosen is waiting for that
  // read, and the assertion that follows the click proves it took.
  await page.reload();
  const ourTab = page.getByTestId(`space-tab-name-${spaceId}`);
  await expect(ourTab).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => page.locator('[role="tab"][aria-selected="true"]').count(), {
      timeout: 30_000,
    })
    .toBe(1);
  await ourTab.click();
  await expect
    .poll(
      async () =>
        ourTab.evaluate((el) =>
          el.closest('[role="tab"]')?.getAttribute('aria-selected'),
        ),
      { timeout: 15_000 },
    )
    .toBe('true');

  await expect
    .poll(async () => imageSources(page), { timeout: 30_000 })
    .toContain(landed);
});

// A2: a video large enough to be sent in several parts, whose cover our own
// worker pulls out of it. Nothing below a real run reaches this: the Durable
// Object's part accounting needs more than one part, and the cover needs
// ffmpeg against bytes that really landed in R2.
test('a multi-part video lands with the cover our worker pulled out of it', async () => {
  test.setTimeout(180_000);

  workDir = mkdtempSync(join(tmpdir(), 'breatic-smoke-'));
  const videoPath = buildMultipartVideo(workDir);
  const size = statSync(videoPath).size;
  // The shipped part size. A file this test could send in one part would prove
  // nothing it is here to prove.
  expect(size).toBeGreaterThan(2 * 8 * 1024 * 1024);

  await dropFile(
    page,
    'multipart.mp4',
    'video/mp4',
    readFileSync(videoPath),
  );

  // The node hears nothing until the cover is out, so this one wait covers the
  // whole chain: every part written, the report accepted, the asset
  // registered, ffmpeg run, and one event carrying both URLs.
  await expect
    .poll(async () => (await videoSources(page)).length, { timeout: 150_000 })
    .toBeGreaterThan(0);
  const [videoUrl] = await videoSources(page);
  expect(videoUrl).toMatch(/^https?:\/\//);

  // The cover rides in on the same event, as the node's poster.
  const poster = await page.evaluate(
    () =>
      (document.querySelector('.react-flow__node video') as HTMLVideoElement)
        ?.poster ?? '',
  );
  expect(poster).toMatch(/^https?:\/\//);
  expect(poster).not.toBe(videoUrl);
});

// Design §5.6 and the §6.6 table put this write on the browser: once its own
// retries are spent the node fails there and then, keeps its Retry stash, and
// says so in the language of the person who tried.
test('a transfer that dies leaves the node failed and says so', async () => {
  // Counted, because a ticket failure reaches the same sink with the same
  // wording: without this the case passes on a glob that matches nothing.
  let aborted = 0;
  await page.route('**/uploads**', (route) => {
    aborted += 1;
    return route.abort('connectionfailed');
  });

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
  // The wording, not just the presence: `storage` and `hash` each raise their
  // own toast from the same function, and picking the wrong one tells the user
  // to retry something a retry cannot fix.
  await expect(page.locator('[data-sonner-toast]')).toContainText(
    'Upload failed',
    { timeout: 5_000 },
  );
  expect(aborted).toBeGreaterThan(0);

  await page.unroute('**/uploads**');
});
