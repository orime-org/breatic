// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The platform-prepared playback file of an uploaded video, run for real (inner#1306 frames-split): every upload is
 * prepared by the ingest Worker's containers; until its presentation P publishes the node plays the original, or shows
 * "Preparing video…" when the browser cannot play the original, and once P publishes every surface plays P. Video focus
 * crop runs in the same containers against P. Extract frames and split themselves are covered by
 * `canvas-mini-tools-batch-6-real-run.spec.ts`; this file covers what is around them.
 *
 * Not covered here, because the real environment cannot produce it on demand:
 * - An old video's first open starting preparation. Every registration path admits preparation itself
 *   (`withPeaksQueued` in `packages/domain/src/asset/ingest-report.service.ts`), so a registered video with no preparation
 *   record at ingest exists only from before the feature or after an admission that failed; the discovery read that would
 *   admit it (`readThenAdmit` in `packages/domain/src/asset/video-presentation.service.ts`) needs such a fixture.
 * - A video focus crop whose run fails: the failed task row reaches the browser only through collab writing the Space
 *   document from the worker's task events, and no request the browser makes carries it.
 *
 * The media are drawn by ffmpeg as the run starts, each carrying a mark of this run so its bytes are new to the studio.
 * Each case uploads its own source, because what it checks happens while that source is still being prepared.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { dataOf } from '../helpers/api';
import { pickFromPlus } from '../helpers/document-body';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { seedNode, wire } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR, visibleSpace } from '../helpers/space';
import { addProjectTimelineVideo, timelineVideoOf } from '../helpers/timeline-media';
import { roomForUploads } from '../helpers/upload-budget';
import {
  contentOf, documentNodes, ffmpeg, FRAME, nodeOf, openCanvas as openVideoCanvas, openExistingSpace, openTool, playbackOf,
  presentationOf, presented, probe, run, seek, stored, upload, type Canvas,
} from '../helpers/video-canvas';

/** Where this run's media are put together. */
let MEDIA = '';

/**
 * Put the run's media in a directory of their own.
 * @returns The directory.
 */
function prepareMedia(): string {
  const dir = mkdtempSync(join(tmpdir(), 'video-presentation-'));
  const mark = (name: string): string[] => ['-metadata', `comment=video-presentation ${name} ${String(Date.now())}`];
  // H.264 with a tone, which the browser plays; long enough that its preparation is still running while a case acts on
  // the original.
  const playable = (name: string, size: string, seconds: number, hz: number): void => ffmpeg(
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${String(seconds)}`,
    '-f', 'lavfi', '-i', `sine=frequency=${String(hz)}:duration=${String(seconds)}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...mark(name), join(dir, name),
  );
  playable('paused.mp4', '320x180', 90, 300);
  playable('playing.mp4', '320x180', 90, 310);
  playable('retry.mp4', '320x180', 60, 320);
  playable('focus.mp4', '640x360', 30, 330);
  playable('refuse.mp4', '640x360', 3, 340);
  playable('frames.mp4', '640x360', 3, 350);
  playable('collab.mp4', '640x360', 6, 360);
  playable('parked.mp4', '640x360', 6, 370);
  // MPEG-2 in QuickTime with no audio: the browser cannot play any track of it, so the original fails in the player.
  for (const name of ['unplayable.mov', 'doc.mov', 'timeline.mov', 'hover.mov']) {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=20', '-c:v', 'mpeg2video', '-q:v', '5', '-an', ...mark(name), join(dir, name));
  }
  // VP9 with alpha: a test pattern in the middle of a transparent frame.
  ffmpeg('-f', 'lavfi', '-i', 'color=c=0x00000000:s=320x240:r=25:d=4,format=rgba', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=25:d=4',
    '-filter_complex', '[0][1]overlay=80:60,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-b:v', '500k',
    ...mark('alpha.webm'), join(dir, 'alpha.webm'));
  return dir;
}

test.use({ viewport: { width: 1680, height: 950 }, actionTimeout: 20_000 });
// Each case uploads, waits for a presentation to be prepared and, for the tool cases, for a container run to finish.
test.setTimeout(30 * 60_000);

test.beforeAll(() => {
  MEDIA = prepareMedia();
});

test.afterAll(() => {
  if (MEDIA !== '') rmSync(MEDIA, { recursive: true, force: true });
});

/** The tiny PNG the pool-full case fills a focus pool with, inline so nothing is fetched. */
const DOT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** How long a waited-for preparation may take. */
const PREPARED = 10 * 60_000;

/**
 * Open a Space of the case's own on the slot's Project.
 * @param page - The case's page.
 * @param label - A name for the Space.
 * @returns The canvas.
 */
function openCanvas(page: Page, label: string): Promise<Canvas> {
  return openVideoCanvas(page, `video-presentation-${label}`, MEDIA);
}

/**
 * What a player's media element plays.
 * @param media - The `media-element` locator.
 * @returns The video's current source, or the element's tag when it is not a video.
 */
function shownSource(media: Locator): Promise<string> {
  return media.evaluate((el) => el instanceof HTMLVideoElement ? el.currentSrc || el.src : el.tagName);
}

/**
 * Fail at once when a source's presentation already published, which would leave the case nothing to check.
 * @param c - The canvas.
 * @param url - The registered original.
 */
async function stillPreparing(c: Canvas, url: string): Promise<void> {
  expect((await presentationOf(c.page, c.projectId, url)).presentation, 'the presentation published before the case could act on the original').toBeNull();
}

/**
 * Fail at once when a source's presentation already published, outside a canvas.
 * @param page - A signed-in page.
 * @param projectId - The Project.
 * @param url - The registered original.
 */
async function stillPreparingAt(page: Page, projectId: string, url: string): Promise<void> {
  expect((await presentationOf(page, projectId, url)).presentation, 'the presentation published before the case could look at it').toBeNull();
}

/**
 * Wait until a player shows a source's playback file, decoded.
 * @param media - The `media-element` locator.
 * @param carrier - The playback file's URL.
 */
async function playsCarrier(media: Locator, carrier: string): Promise<void> {
  await expect.poll(() => shownSource(media), { timeout: 2 * 60_000 }).toBe(carrier);
  await expect.poll(() => media.evaluate((el: HTMLVideoElement) => el.readyState >= 2 && !el.seeking), { timeout: 60_000 }).toBe(true);
}

/**
 * The Project's credits as its credits view reports them.
 * @param page - A signed-in page.
 * @param projectId - The Project.
 * @returns Spendable, held and available.
 */
async function credits(page: Page, projectId: string): Promise<Record<string, unknown>> {
  return dataOf<Record<string, unknown>>(
    await page.request.get(`/api/v1/projects/${projectId}/credits`, { params: { amountFormat: 'decimal-v1' } }),
    'read the Project credits',
  );
}

/**
 * Open the Generate panel of a node from its menu.
 * @param page - The page.
 * @param nodeId - The node.
 */
async function openGenerate(page: Page, nodeId: string): Promise<void> {
  await visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`).click({ button: 'right' });
  await page.getByTestId('node-menu-generate').click();
}

/**
 * Pick a source for the open Generate panel's focus crop.
 * @param c - The canvas.
 * @param file - The source.
 * @param page - The page; the canvas's own when absent.
 */
async function pickForFocus(c: Canvas, file: string, page: Page = c.page): Promise<void> {
  await nodeOf(c, file, page).click();
  await expect(page.getByTestId('focus-crop-controls')).toBeVisible({ timeout: 15_000 });
}

/**
 * Draw a crop box across most of a picked node and wait until it can be confirmed.
 * @param c - The canvas.
 * @param file - The picked source.
 */
async function drawCrop(c: Canvas, file: string): Promise<void> {
  const layer = nodeOf(c, file).getByTestId('focus-crop-layer');
  await expect(layer).toBeVisible();
  const box = (await layer.boundingBox())!;
  await c.page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await c.page.mouse.down();
  await c.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 8 });
  await c.page.mouse.up();
  await expect(c.page.getByTestId('focus-crop-confirm')).toBeEnabled();
}

/**
 * The focus images the document holds on a node, as one page sees them.
 * @param c - The canvas.
 * @param nodeId - The node.
 * @param page - The page; the canvas's own when absent.
 * @returns How many.
 */
async function focusCount(c: Canvas, nodeId: string, page: Page = c.page): Promise<number> {
  const node = (await documentNodes(c, page)).find((n) => n.id === nodeId);
  return Array.isArray(node?.data.focusImages) ? node.data.focusImages.length : 0;
}

/**
 * A stored frame's alpha at two points, decoded by libvpx (ffmpeg's own VP9 decoder drops the alpha plane).
 * @param url - The stored WebM.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The alpha at the top-left corner and at the centre.
 */
function alphaAt(url: string, width: number, height: number): { corner: number; centre: number } {
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-c:v', 'libvpx-vp9', '-i', url, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 });
  return { corner: rgba[3]!, centre: rgba[(Math.floor(height / 2) * width + Math.floor(width / 2)) * 4 + 3]! };
}

/**
 * The toasts on a page.
 * @param page - The page.
 * @returns Their locator.
 */
function toasts(page: Page): Locator {
  return page.locator('[data-sonner-toast]');
}

test('split: every part of a transparent source keeps its transparency @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'alpha-split');
  try {
    await upload(c, 'alpha.webm');
    // A transparent source plays through its alpha-packed presentation, drawn on a canvas.
    const original = await contentOf(c, 'alpha.webm');
    await playbackOf(page, c.projectId, original);
    expect((await presentationOf(page, c.projectId, original)).presentation?.playback.kind).toBe('alpha-packed');
    // An alpha-packed node rests on its cover until the user reaches it (the page keeps few WebGL contexts), so the
    // pointer goes over it.
    const node = nodeOf(c, 'alpha.webm');
    await expect.poll(async () => {
      await node.hover();
      const media = node.getByTestId('media-element');
      return await media.count() === 0 ? 'resting' : media.evaluate((el) => el.tagName);
    }, { timeout: 2 * 60_000 }).toBe('CANVAS');
    await presented(c, 'alpha.webm');
    await openTool(c, 'alpha.webm', 'video.split');
    // The player draws on a canvas, so the playhead is moved through the seek bar and the cut typed where it goes.
    await node.hover();
    const bar = (await node.getByTestId('seek').boundingBox())!;
    await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
    await expect(node.getByTestId('time-current')).not.toHaveText('0:00');
    await expect(c.page.getByTestId('video-add-cut')).toBeEnabled({ timeout: 15_000 });
    await c.page.getByTestId('video-add-cut').click();
    const cut = c.page.getByTestId('video-cut-0');
    await cut.fill('2');
    await cut.press('Tab');
    await expect(cut).toHaveValue('2');
    const made = await run(c, 2);
    await c.page.keyboard.press('Escape');
    const parts = await stored(c, made);
    for (const part of parts) {
      expect(part.type).toBe('video');
      const read = probe(part.content);
      const video = read.streams.find((s) => s.codec_type === 'video')!;
      expect(read.format.format_name).toContain('webm');
      expect(video.codec_name).toBe('vp9');
      expect(Object.entries(video.tags ?? {}).find(([key]) => key.toLowerCase() === 'alpha_mode')?.[1]).toBe('1');
      // The frame around the pattern stays transparent and the pattern stays opaque.
      expect(alphaAt(part.content, video.width!, video.height!)).toEqual({ corner: 0, centre: 255 });
    }
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('a node paused on its original switches to the prepared file at the same time, still paused @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'paused');
  try {
    await upload(c, 'paused.mp4');
    const original = await contentOf(c, 'paused.mp4');
    const media = nodeOf(c, 'paused.mp4').getByTestId('media-element');
    // While the presentation is prepared, the node plays the original.
    await expect.poll(() => shownSource(media), { timeout: 60_000 }).toBe(original);
    await stillPreparing(c, original);
    await seek(c, 'paused.mp4', 0.4);
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => !el.seeking)).toBe(true);
    const at = await media.evaluate((el: HTMLMediaElement) => el.currentTime);
    expect(await media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    await playsCarrier(media, await playbackOf(page, c.projectId, original));
    expect(await media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    // The prepared file lands on the grid frame the original was paused in.
    expect(Math.abs(await media.evaluate((el: HTMLMediaElement) => el.currentTime) - at)).toBeLessThanOrEqual(FRAME);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('a node playing its original switches to the prepared file and plays on from where it was @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'playing');
  try {
    await upload(c, 'playing.mp4');
    const original = await contentOf(c, 'playing.mp4');
    const node = nodeOf(c, 'playing.mp4');
    const media = node.getByTestId('media-element');
    await expect.poll(() => shownSource(media), { timeout: 60_000 }).toBe(original);
    await stillPreparing(c, original);
    await node.hover();
    await node.getByTestId('play-toggle').click();
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => !el.paused && el.currentTime > 0)).toBe(true);
    // The last time the original reached before the node switched. Preparing takes longer than the clip runs, so the
    // user takes the playhead back through the seek bar whenever the original nears its end, and it keeps playing.
    let last = 0;
    await expect.poll(async () => {
      const shown = await media.evaluate((el) => el instanceof HTMLVideoElement
        ? { src: el.currentSrc, time: el.currentTime, end: el.duration } : { src: el.tagName, time: 0, end: 0 });
      if (shown.src !== original) return shown.src;
      last = shown.time;
      if (shown.time > shown.end - 5) {
        await node.hover();
        const bar = (await node.getByTestId('seek').boundingBox())!;
        await page.mouse.click(bar.x + bar.width * 0.1, bar.y + bar.height / 2);
        // The next read gives the time after the seek.
        last = 0;
      }
      return 'original';
    }, { timeout: PREPARED, intervals: [200] }).not.toBe('original');
    await playsCarrier(media, await playbackOf(page, c.projectId, original));
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => !el.paused && el.currentTime > 0)).toBe(true);
    // It plays on from there rather than starting over.
    expect(await media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThanOrEqual(last - FRAME);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('an original the browser cannot play shows Preparing video… until the prepared file plays @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'unplayable');
  try {
    await upload(c, 'unplayable.mov');
    const original = await contentOf(c, 'unplayable.mov');
    const node = nodeOf(c, 'unplayable.mov');
    const notice = node.getByTestId('video-preparation-notice');
    await expect(notice).toContainText('Preparing video…', { timeout: 60_000 });
    // The notice stands for the original failing in the player, not for a player error.
    expect(await node.getByTestId('media-element').evaluate((el: HTMLVideoElement) => el.error?.code ?? null)).not.toBeNull();
    await expect(node.getByText('Media unavailable')).toHaveCount(0);
    await playsCarrier(node.getByTestId('media-element'), await playbackOf(page, c.projectId, original));
    await expect(notice).toHaveCount(0);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('a preparation failure offers Retry, and Retry prepares the video @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  // A temporary preparation failure (a container lost mid-run, say) cannot be caused on demand, so the presentation reads
  // of this page answer the real response with its candidate failed the way the server reports one: nothing selected,
  // the target preparation carrying `presentation_failed`, and no further polling. Retry's repair goes to the real
  // server, and every read after it is answered by the real server too.
  let failing = true;
  let preparation: unknown = null;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/assets/video-presentation/repair')) failing = false;
  });
  await page.route((url) => url.pathname.endsWith('/assets/video-presentation'), async (route) => {
    if (route.request().method() !== 'GET' || !failing) return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { data: { presentation: unknown; preparation: unknown; pollAfterMs: number | null } };
    if (body.data.preparation !== null) preparation = body.data.preparation;
    if (preparation !== null) {
      body.data = { ...body.data, presentation: null, preparation: { ...(preparation as object), failure: 'presentation_failed' }, pollAfterMs: null };
    }
    await route.fulfill({ response, json: body });
  });
  const c = await openCanvas(page, 'retry');
  try {
    await upload(c, 'retry.mp4');
    const original = await contentOf(c, 'retry.mp4');
    const node = nodeOf(c, 'retry.mp4');
    const notice = node.getByTestId('video-preparation-notice');
    await expect(notice).toContainText('Couldn\'t prepare the video', { timeout: 60_000 });
    const repaired = page.waitForResponse((response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/assets/video-presentation/repair'));
    await notice.getByRole('button', { name: 'Retry', exact: true }).click();
    expect((await repaired).ok()).toBe(true);
    await playsCarrier(node.getByTestId('media-element'), await playbackOf(page, c.projectId, original));
    await expect(notice).toHaveCount(0);
    await expect(toasts(page)).toHaveCount(0);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('a Document video block shows the cover and Preparing video… and then plays the prepared file @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'document', `video-presentation-doc-${String(Date.now())}`);
  try {
    const editor = page.locator(DOCUMENT_EDITOR);
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await roomForUploads(1);
    await pickFromPlus(page, 'video', { name: 'doc.mov', mimeType: 'video/quicktime', buffer: readFileSync(join(MEDIA, 'doc.mov')) });
    const block = page.locator(`${DOCUMENT_EDITOR} [data-content-type="video"]`);
    const notice = block.getByTestId('video-preparation-notice');
    await expect(notice).toContainText('Preparing video…', { timeout: 2 * 60_000 });
    const original = (await block.locator('video').getAttribute('src'))!;
    expect(original).toMatch(/^https?:\/\//);
    await stillPreparingAt(page, projectId, original);
    await expect(notice.locator('img')).toHaveAttribute('src', /^(https?:|blob:|data:)/);
    await playsCarrier(block.getByTestId('media-element'), await playbackOf(page, projectId, original));
    await expect(notice).toHaveCount(0);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('a Timeline clip shows the cover and Preparing video… and then plays the prepared file @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  // The video is registered through the canvas and placed from the Project: a local file goes through the Timeline's own
  // duration read in the browser first (`decodeDuration` in timeline-media-draft.ts), which a video the browser cannot
  // play does not pass, while a Project video takes its registered duration.
  const c = await openCanvas(page, 'timeline-source');
  let spaceId = '';
  try {
    await upload(c, 'timeline.mov');
    const original = await contentOf(c, 'timeline.mov');
    const assetId = (await presentationOf(page, c.projectId, original)).sourceBinding.assetId;
    spaceId = await createSpace(page, 'timeline', `video-presentation-timeline-${String(Date.now())}`);
    const outlet = visibleSpace(page);
    const clipId = await addProjectTimelineVideo(page, assetId);
    const video = timelineVideoOf(page, clipId);
    await expect(outlet.getByTestId(`timeline-preview-note-${clipId}`)).toContainText('Preparing video…', { timeout: 60_000 });
    await expect(video).toHaveAttribute('src', original);
    await stillPreparing(c, original);
    await expect(video).toHaveAttribute('poster', /^https?:\/\//);
    const carrier = await playbackOf(page, c.projectId, original);
    await expect(video).toHaveAttribute('src', carrier, { timeout: 2 * 60_000 });
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState >= 2 && el.error === null), { timeout: 60_000 }).toBe(true);
    await expect(outlet.getByTestId(`timeline-preview-note-${clipId}`)).toHaveCount(0);
  } finally {
    if (spaceId !== '') await deleteSpace(page, spaceId);
    await deleteSpace(page, c.spaceId);
  }
});

test('the canvas hover preview shows the cover and Preparing video… and then plays the prepared file @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'hover');
  try {
    await upload(c, 'hover.mov');
    const original = await contentOf(c, 'hover.mov');
    const source = c.sources.get('hover.mov')!;
    // The reference is wired through the document: connecting it is not what this case checks.
    const host = randomUUID();
    await seedNode(page, c, host, 'image', 700);
    await wire(page, c, source, host);
    await openGenerate(page, host);
    const row = page.getByTestId(`generate-ref-insert-${source}->${host}`);
    await row.hover();
    const card = page.getByTestId('hover-preview-content');
    const notice = card.getByTestId('video-preparation-notice');
    await expect(notice).toContainText('Preparing video…', { timeout: 60_000 });
    await stillPreparing(c, original);
    await expect(notice.locator('img')).toHaveAttribute('src', /^https?:\/\//);
    // The preview offers no Retry; it only shows the state.
    await expect(notice.getByRole('button')).toHaveCount(0);
    const carrier = await playbackOf(page, c.projectId, original);
    await row.hover();
    await playsCarrier(card.getByTestId('media-element'), carrier);
    await expect(notice).toHaveCount(0);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('video focus crop: blocked while preparing, a waiting card at once, replaced on delivery, no credits spent @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'focus');
  try {
    await upload(c, 'focus.mp4');
    const original = await contentOf(c, 'focus.mp4');
    const host = randomUUID();
    await seedNode(page, c, host, 'image', 800);
    const before = await credits(page, c.projectId);
    await openGenerate(page, host);
    await page.getByTestId('generate-tool-focus').click();
    await pickForFocus(c, 'focus.mp4');
    // While the presentation is prepared there is no frame grid to crop from: Confirm cannot be pressed.
    await stillPreparing(c, original);
    await expect(page.getByTestId('focus-crop-source-waiting')).toHaveText('Preparing video…');
    await expect(page.getByTestId('focus-crop-confirm')).toBeDisabled();
    await expect(page.getByTestId('focus-crop-timeline')).toBeVisible({ timeout: PREPARED });
    await drawCrop(c, 'focus.mp4');
    const pending = page.locator('[data-testid^="generate-focus-pending-"]');
    await page.getByTestId('focus-crop-confirm').click();
    await expect(pending).toHaveCount(1, { timeout: 1_000 });
    await expect(pending).toHaveCount(0, { timeout: 10 * 60_000 });
    expect(await focusCount(c, host)).toBe(1);
    await expect(page.locator('[data-testid^="generate-ref-focus-badge-"]')).toHaveCount(1);
    await expect(toasts(page)).toHaveCount(0);
    // A focus crop is platform funded: the Project's credits are where they were.
    await page.waitForTimeout(10_000);
    expect(await credits(page, c.projectId)).toEqual(before);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('video focus crop: an admission refusal removes the waiting card and says why @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  // Stands for the admission's own refusal of a focus crop whose source no longer matches what the press named, which
  // cannot be reached on demand: `ValidationError(t("server.mini_tool.foreignSource"))` in
  // packages/domain/src/mini-tool/execution-admission.service.ts, answered by core's error handler
  // (packages/core/src/http/error-handler.ts) as 400 with `{ error: { code, message } }`. A rate-limit 429 would not do:
  // run-once treats it as an unknown outcome and sends the press again.
  await page.route((url) => url.pathname === '/api/v1/mini-tools', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST' || (request.postDataJSON() as { tool?: string }).tool !== 'video.focus-crop') return route.fallback();
    // Answered after a moment, as admission takes, so the waiting card is on screen first.
    await new Promise((resolve) => { setTimeout(resolve, 2_000); });
    await route.fulfill({ status: 400, json: { error: { code: 400, message: 'This file cannot be processed.' } } });
  });
  const c = await openCanvas(page, 'focus-refused');
  try {
    await upload(c, 'refuse.mp4');
    await presented(c, 'refuse.mp4');
    const host = randomUUID();
    await seedNode(page, c, host, 'image', 800);
    await openGenerate(page, host);
    await page.getByTestId('generate-tool-focus').click();
    await pickForFocus(c, 'refuse.mp4');
    await expect(page.getByTestId('focus-crop-timeline')).toBeVisible({ timeout: PREPARED });
    await drawCrop(c, 'refuse.mp4');
    const pending = page.locator('[data-testid^="generate-focus-pending-"]');
    await page.getByTestId('focus-crop-confirm').click();
    await expect(pending).toHaveCount(1, { timeout: 1_000 });
    await expect(toasts(page).filter({ hasText: 'This file cannot be processed.' })).toHaveCount(1, { timeout: 15_000 });
    await expect(pending).toHaveCount(0);
    expect(await focusCount(c, host)).toBe(0);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('extract frames: the panel says Free and a run spends no credits @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'frames-free');
  try {
    await upload(c, 'frames.mp4');
    await presented(c, 'frames.mp4');
    await openTool(c, 'frames.mp4', 'video.extract-frames');
    await expect(page.getByTestId('mini-tool-credit')).toHaveText('Free');
    const before = await credits(page, c.projectId);
    await page.getByTestId('video-frame-mode-first').click();
    const made = await run(c, 1);
    await page.keyboard.press('Escape');
    await stored(c, made);
    await page.waitForTimeout(10_000);
    expect(await credits(page, c.projectId)).toEqual(before);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

/**
 * Open a second session of the same account on a canvas: a second tab is a second collab connection to the document.
 * @param c - The canvas.
 * @param file - A source it must show.
 * @returns The second session's page.
 */
async function secondSession(c: Canvas, file: string): Promise<Page> {
  const peer = await c.page.context().newPage();
  await openSmokeProject(peer);
  await openExistingSpace(peer, c.spaceId);
  await expect(nodeOf(c, file, peer)).toBeVisible({ timeout: 30_000 });
  return peer;
}

test('two sessions on one split draft see the same cut edits and the same result nodes @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'collab-split');
  let peer: Page | null = null;
  try {
    await upload(c, 'collab.mp4');
    await presented(c, 'collab.mp4');
    peer = await secondSession(c, 'collab.mp4');
    await openTool(c, 'collab.mp4', 'video.split');
    await openTool(c, 'collab.mp4', 'video.split', peer);
    await seek(c, 'collab.mp4', 0.5);
    await page.getByTestId('video-add-cut').click();
    const mine = page.getByTestId('video-cut-0');
    const theirs = peer.getByTestId('video-cut-0');
    await expect(mine).toBeVisible();
    await expect(theirs).toHaveValue(await mine.inputValue(), { timeout: 15_000 });
    await theirs.fill('2');
    await theirs.press('Tab');
    await expect(mine).toHaveValue('2', { timeout: 15_000 });
    const made = await run(c, 2);
    await page.keyboard.press('Escape');
    await peer.keyboard.press('Escape');
    const parts = await stored(c, made);
    await expect.poll(async () => (await documentNodes(c, peer!)).filter((n) => made.includes(n.id)).map((n) => n.content).sort(), { timeout: 60_000 })
      .toEqual(parts.map((n) => n.content).sort());
    for (const id of made) await expect(visibleSpace(peer).locator(`.react-flow__node[data-id="${id}"]`)).toBeAttached();
  } finally {
    await peer?.close();
    await deleteSpace(page, c.spaceId);
  }
});

test('a focus crop result reaches the collaborator; the waiting card and the pool-full toast stay with the initiator @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'collab-focus');
  let peer: Page | null = null;
  try {
    await upload(c, 'collab.mp4');
    await presented(c, 'collab.mp4');
    const host = randomUUID();
    await seedNode(page, c, host, 'image', 800);
    peer = await secondSession(c, 'collab.mp4');
    await openGenerate(peer, host);
    await expect(peer.getByTestId('generate-tool-focus')).toBeVisible();
    await openGenerate(page, host);
    await page.getByTestId('generate-tool-focus').click();
    await pickForFocus(c, 'collab.mp4');
    await expect(page.getByTestId('focus-crop-timeline')).toBeVisible({ timeout: PREPARED });
    await drawCrop(c, 'collab.mp4');
    const pending = (p: Page): Locator => p.locator('[data-testid^="generate-focus-pending-"]');
    await page.getByTestId('focus-crop-confirm').click();
    await expect(pending(page)).toHaveCount(1, { timeout: 1_000 });
    await expect(pending(peer)).toHaveCount(0);
    await expect(pending(page)).toHaveCount(0, { timeout: 10 * 60_000 });
    await expect.poll(() => focusCount(c, host, peer!), { timeout: 30_000 }).toBe(1);
    await expect(peer.locator('[data-testid^="generate-ref-focus-badge-"]')).toHaveCount(1);

    // A crop that collab refuses because the pool filled while it ran: the toast is the initiator's alone. The
    // collaborator fills the pool through the page's own append, which refuses at the 200-entry ceiling collab holds to;
    // through the UI every client also holds to the smaller `canvas_reference_pool_cap`, so this race is reached when that
    // knob is above 200.
    await pickForFocus(c, 'collab.mp4');
    await expect(page.getByTestId('focus-crop-timeline')).toBeVisible();
    await drawCrop(c, 'collab.mp4');
    await page.getByTestId('focus-crop-confirm').click();
    await expect(pending(page)).toHaveCount(1, { timeout: 1_000 });
    const at = await liveModuleUrl(peer, CANVAS_SPACE);
    const filled = await peer.evaluate(async ([pid, sid, id, png, url]: [string, string, string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        addNodeFocusImage: (p: string, s: string, n: string, image: { id: string; url: string; name: string; width: number; height: number }) => string;
      };
      let added = 0;
      while (canvas.addNodeFocusImage(pid, sid, id, { id: crypto.randomUUID(), url: png, name: 'fill', width: 1, height: 1 }) === 'added') added += 1;
      return added;
    }, [c.projectId, c.spaceId, host, DOT_PNG, at] as [string, string, string, string, string]);
    expect(filled).toBe(199);
    const poolFull = 'Reference pool is full (200 max) — remove some references or focus crops first.';
    await expect(toasts(page).filter({ hasText: poolFull })).toHaveCount(1, { timeout: 10 * 60_000 });
    await expect(pending(page)).toHaveCount(0);
    await peer.waitForTimeout(2_000);
    await expect(toasts(peer).filter({ hasText: poolFull })).toHaveCount(0);
    expect(await focusCount(c, host, peer)).toBe(200);
  } finally {
    await peer?.close();
    await deleteSpace(page, c.spaceId);
  }
});

test('video focus crop on a video just split, in one session @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  // The user splits a video, closes the panel, then crops a frame of the same video into a Generate panel.
  const c = await openCanvas(page, 'focus-after-split');
  try {
    await upload(c, 'parked.mp4');
    await presented(c, 'parked.mp4');
    const host = randomUUID();
    await seedNode(page, c, host, 'image', 800);
    await openTool(c, 'parked.mp4', 'video.split');
    await seek(c, 'parked.mp4', 0.5);
    await page.getByTestId('video-add-cut').click();
    const cut = page.getByTestId('video-cut-0');
    await cut.fill('2');
    await cut.press('Tab');
    await stored(c, await run(c, 2));
    await page.keyboard.press('Escape');
    await openGenerate(page, host);
    await page.getByTestId('generate-tool-focus').click();
    await pickForFocus(c, 'parked.mp4');
    await expect(page.getByTestId('focus-crop-timeline')).toBeVisible({ timeout: PREPARED });
    await drawCrop(c, 'parked.mp4');
    await page.getByTestId('focus-crop-confirm').click();
    await expect(page.locator('[data-testid^="generate-focus-pending-"]')).toHaveCount(1, { timeout: 1_000 });
    await expect(toasts(page)).toHaveCount(0);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});
