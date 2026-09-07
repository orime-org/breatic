// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas upload through the ingest Worker E2E (#173) — the half no unit test
 * reaches.
 *
 * Two things live here because nothing below a real browser can answer them.
 * The first is A1: a picked file's bytes travel to the Worker, the server
 * registers them, and the URL that lands on the node survives a reload. The
 * second is what happens when the transfer dies partway. Where it dies decides
 * everything (#186 §3.7.3): after the ticket a row and a grant exist, and the
 * row reaches an end without the browser — the server judges it against its
 * budget the next time somebody reads that node's task list. Before the ticket
 * nothing exists, so the empty node the drop made has to go. `failUploadNode` holds both
 * halves and lives inside a `useCallback` no unit test can call.
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
 * which is the whole point of this file, since one part exercises neither the
 * part list the browser has to hand back nor the layout check over it.
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

/**
 * Wait until no toast is on screen.
 *
 * These cases run in one page, in order, and a toast lives a few seconds. A
 * case that asserts on toast text without this passes on the one the case
 * before it raised — the failure it is here to catch never has to happen.
 * @param target - The page to settle.
 */
async function noToastLeft(target: Page): Promise<void> {
  await expect
    .poll(async () => target.locator('[data-sonner-toast]').count(), {
      timeout: 15_000,
    })
    .toBe(0);
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
  // Every byte here crosses the public internet twice — up to the bucket, and
  // back down for the hash and for ffmpeg — so this case is paced by a real
  // remote round trip, not by our code. Measured on a developer machine the
  // 25 MiB clip takes about three minutes end to end, of which `complete`
  // alone is over a minute (assemble, then read the object back to hash it).
  // This is a ceiling rather than an estimate of that: past it, something is
  // wrong rather than merely far away.
  test.setTimeout(420_000);

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
    .poll(async () => (await videoSources(page)).length, { timeout: 360_000 })
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

// A4: the second drop of a file this studio already stores sends no bytes and
// lands on the URL of the row that is already there. The answer that decides
// this is given at the ticket, which is the one place a unit test cannot reach
// with a real hash of real bytes.
test('a file already stored is answered without sending it again', async () => {
  // Counted from where the earlier cases left the canvas, so what is measured
  // is what this one adds.
  const before = (await imageSources(page)).length;
  const bytes = Buffer.concat([TINY_PNG, randomBytes(16)]);
  await dropFile(page, 'twice.png', 'image/png', bytes);
  await expect
    .poll(async () => (await imageSources(page)).length, { timeout: 30_000 })
    .toBe(before + 1);
  const first = (await imageSources(page))[before] as string;

  // Counted from here, so what it counts is the second drop alone. A dedup hit
  // is answered by the ticket endpoint and never reaches the Worker.
  let sentToWorker = 0;
  await page.route('**/uploads**', (route) => {
    sentToWorker += 1;
    return route.continue();
  });

  await dropFile(page, 'twice-again.png', 'image/png', bytes);

  await expect
    .poll(async () => (await imageSources(page)).length, { timeout: 30_000 })
    .toBe(before + 2);
  // Both nodes resolve to the row that was already there, whichever order the
  // canvas renders them in.
  const added = (await imageSources(page)).slice(before);
  expect(new Set(added)).toEqual(new Set([first]));
  expect(sentToWorker).toBe(0);

  await page.unroute('**/uploads**');
});

// B1: the cover is a second asset on its own job. When ffmpeg cannot cut a
// frame the video is still stored, still registered and still on the node —
// what it lacks is a poster. Nothing below a real run reaches this: it needs
// our worker to actually try, and fail, on bytes that really landed in R2.
test('a video whose frame cannot be cut still lands, without a cover', async () => {
  test.setTimeout(180_000);

  // Declared as a video and stored as one; the pipeline takes the ticket's
  // word for the type and never measures the bytes. ffmpeg is what finds out,
  // which is exactly the failure this case is about.
  await dropFile(
    page,
    'not-really.mp4',
    'video/mp4',
    Buffer.concat([Buffer.from('ftypmp42'), randomBytes(4096)]),
  );

  await expect
    .poll(async () => (await videoSources(page)).length, { timeout: 120_000 })
    .toBeGreaterThan(1);
  const sources = await videoSources(page);
  const landed = sources[sources.length - 1] as string;
  expect(landed).toMatch(/^https?:\/\//);

  // Held for a while: a poster that arrives late would make this pass on
  // timing rather than on the outcome.
  await page.waitForTimeout(5_000);
  const poster = await page.evaluate(() => {
    const videos = [...document.querySelectorAll('.react-flow__node video')];
    return (videos[videos.length - 1] as HTMLVideoElement | undefined)?.poster ?? '';
  });
  expect(poster).toBe('');
});

// A5: a transfer that dies AFTER the ticket. The row, its grant and its timer
// all exist, so the row walks to an end on its own (#186 §3.7.3, fourth line)
// — the browser writes nothing to the shared document. What it does do is tell
// the person who tried, in their language, and keep the file their Retry
// re-sends. The node stays: it has a task, and that task has an owner.
test('a transfer that dies after the ticket tells the uploader and leaves the node alone', async () => {
  // Counted, because a route that matches nothing aborts nothing and this case
  // would then pass on an upload that simply succeeded.
  let aborted = 0;
  await page.route('**/uploads**', (route) => {
    aborted += 1;
    return route.abort('connectionfailed');
  });

  await noToastLeft(page);
  const before = (await imageSources(page)).length;
  const nodesBefore = await page.locator('.react-flow__node').count();

  // Bytes no earlier run has stored: an identical file hits dedup at the
  // ticket, which answers with the existing URL and sends nothing to abort.
  await dropFile(
    page,
    'doomed.png',
    'image/png',
    Buffer.concat([TINY_PNG, randomBytes(16)]),
  );

  // The abort first: a route that matched nothing would leave the assertions
  // below describing an upload that simply worked.
  await expect.poll(() => aborted, { timeout: 60_000 }).toBeGreaterThan(0);
  // The wording, not just the presence: `storage` and `hash` each raise their
  // own toast from the same function, and picking the wrong one tells the user
  // to retry something a retry cannot fix.
  await expect(page.locator('[data-sonner-toast]')).toContainText(
    'Upload failed.',
    { timeout: 30_000 },
  );

  // The node the drop created is still there, and still has no content: its
  // task is running and only the timer decides when that stops being true.
  expect(await page.locator('.react-flow__node').count()).toBe(nodesBefore + 1);
  expect((await imageSources(page)).length).toBe(before);
  // The fixed English sentence this used to write into the shared document is
  // gone (§3.7.2) — every collaborator read it, in the uploader's words.
  await expect(page.getByText(/Upload failed: doomed\.png/)).toHaveCount(0);

  await page.unroute('**/uploads**');
});

// A6: a transfer that dies BEFORE the ticket is answered. Nothing exists on the
// server — no row, no grant, no timer — so nobody is coming to end this. The
// node this drop created has never held anything and never will, so it goes
// (#186 §3.7.3, first three lines).
test('a drop that never gets a ticket takes its own empty node away', async () => {
  let aborted = 0;
  await page.route('**/assets/upload-ticket*', (route) => {
    aborted += 1;
    return route.abort('connectionfailed');
  });

  await noToastLeft(page);
  const nodesBefore = await page.locator('.react-flow__node').count();

  await dropFile(
    page,
    'ticketless.png',
    'image/png',
    Buffer.concat([TINY_PNG, randomBytes(16)]),
  );

  await expect.poll(() => aborted, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect(page.locator('[data-sonner-toast]')).toContainText(
    'Upload failed.',
    { timeout: 30_000 },
  );

  // Back to where we started: the empty node did not survive the drop.
  await expect
    .poll(async () => page.locator('.react-flow__node').count(), {
      timeout: 15_000,
    })
    .toBe(nodesBefore);

  await page.unroute('**/assets/upload-ticket*');
});
