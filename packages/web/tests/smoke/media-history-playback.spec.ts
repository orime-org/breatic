// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { roomForUploads } from '../helpers/upload-budget';

// Real decoded media; both tracks are present so audio and video exercise the
// native load algorithm. Generated once with ffmpeg (64x48 blue + silent AAC,
// 15 seconds); no external service or ffmpeg installation is needed to run.
const clip = readFileSync(resolve(__dirname, '../fixtures/media-history.mp4'));

test.use({ viewport: { width: 1680, height: 1100 } });

// A canvas video plays through a server presentation of a registered asset, so
// the video case below uploads its clips; this loop is the audio case alone.
for (const kind of ['audio'] as const) {
  test(`${kind}: history replacement leaves a playable resource`, async ({ page }) => {
    await openSmokeProject(page);
    const projectId = smokeProjectId();
    const initialUrl = page.url();
    const spaceId = await createSpace(page, 'canvas', `media-history-${kind}-${Date.now()}`);
    try {
      await expect(visibleSpace(page).locator('.react-flow')).toBeVisible();
      const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
      const nodeId = crypto.randomUUID();
      const origin = new URL(page.url()).origin;
      const urls = [0, 1, 2].map((i) => `${origin}/media-history-fixture-${kind}-${i}.mp4`);
      let releaseMedia: () => void = () => {};
      const pendingMedia = new Promise<void>((resolve) => { releaseMedia = resolve; });
      await page.route('**/media-history-fixture-*.mp4', async (route) => {
        if (route.request().url() === urls[1]) await pendingMedia;
        await route.fulfill({ contentType: 'video/mp4', body: clip });
      });
      // Only the history listing is a fixture. Restoration, Yjs, player DOM,
      // decoding, media events and clicks use the application's real paths.
      await page.route(`**/canvas/nodes/${nodeId}/history?*`, (route) =>
        route.fulfill({ json: { data: { total: 3, entries: urls.map((content, i) => ({
          id: `history-${i}`, entryType: 'upload', status: 'success', content,
          thumbnailUrl: null, errorMessage: null, operatorName: null,
          metadata: { filename: `clip-${i}.mp4` }, createdAt: '2026-09-22T00:00:00Z',
        })) } } }));
      await page.evaluate(async ({ at, pid, sid, id, type, src }) => {
        const canvas = await import(/* @vite-ignore */ at);
        canvas.addNode(pid, sid, {
          id, type, position: { x: 100, y: 80 },
          data: { name: 'history-player', createdAt: Date.now(), createdBy: 'playback-test',
            locked: false, state: 'idle', attachments: [], content: src },
        });
      }, { at: canvasAt, pid: projectId, sid: spaceId, id: nodeId, type: kind, src: urls[0] });
      const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
      const media = node.getByTestId('media-element');
      const toggle = node.getByTestId('play-toggle');
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(2);
      await toggle.click();
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
      await node.click({ button: 'right' });
      await page.getByTestId('node-menu-history').click();
      for (const index of [1, 2, 0]) {
        await page.getByTestId('node-history-row').filter({ hasText: `clip-${index}.mp4` })
          .getByTestId('node-history-restore').click();
        await expect(media).toHaveAttribute('src', urls[index]);
        await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
        await expect(toggle).toHaveAttribute('aria-label', 'Play');
        if (index === 1) {
          // Playback can be requested and cancelled while bytes are pending.
          // No synthetic media events: the browser resolves both operations.
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-label', 'Pause');
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-label', 'Play');
          releaseMedia();
        }
        await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(2);
        await toggle.click();
        await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
        await expect(toggle).toHaveAttribute('aria-label', 'Pause');
      }
      await toggle.click();
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
      await expect(toggle).toHaveAttribute('aria-label', 'Play');
      // Replacing an already paused resource must not start it either.
      await page.getByTestId('node-history-row').filter({ hasText: 'clip-1.mp4' })
        .getByTestId('node-history-restore').click();
      await expect(media).toHaveAttribute('src', urls[1]);
      await expect(toggle).toHaveAttribute('aria-label', 'Play');
      await toggle.click();
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
      await expect(page).toHaveURL(initialUrl);
    } finally {
      await deleteSpace(page, spaceId);
    }
  });
}

/** A presentation answer held until the case opens it. */
interface Gate {
  opened: Promise<void>;
  open: () => void;
}

/**
 * Every node on a canvas with its content.
 * @param page - A page with the Space open.
 * @param projectId - The project.
 * @param spaceId - The Space.
 * @returns Content by node id.
 */
async function nodeContents(page: Page, projectId: string, spaceId: string): Promise<Map<string, string>> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return new Map(await page.evaluate(async ([pid, sid, url]: [string, string, string]) => {
    const canvas = (await import(/* @vite-ignore */ url)) as {
      readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data?: { content?: string } }[] };
    };
    return canvas.readCanvasGraph(pid, sid).nodes.map((n): [string, string] => [n.id, n.data?.content ?? '']);
  }, [projectId, spaceId, at] as [string, string, string]));
}

// A canvas video plays only a registered asset, through the presentation the
// server prepares for it, so the clips are real uploads: three copies of the
// fixture, each with bytes of its own so none is answered by another's row.
test('video: history replacement leaves a playable resource @needs-ffmpeg @needs-ingest @needs-storage', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const initialUrl = page.url();
  const spaceId = await createSpace(page, 'canvas', `media-history-video-${Date.now()}`);
  const dir = mkdtempSync(join(tmpdir(), 'media-history-'));
  // The presentation of every clip but the player's first is held until the
  // case lets it through, so a restored clip can be caught still preparing.
  const urls: string[] = [];
  const gates = new Map<string, Gate>();
  const gate = (url: string): Gate => {
    let entry = gates.get(url);
    if (entry === undefined) {
      let open: () => void = () => {};
      const opened = new Promise<void>((resolve) => { open = resolve; });
      entry = { opened, open };
      gates.set(url, entry);
    }
    return entry;
  };
  try {
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible();
    const canvasAt = await liveModuleUrl(page, CANVAS_SPACE);
    const run = Date.now();
    const files = [0, 1, 2].map((i) => {
      const out = join(dir, `clip-${i}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', resolve(__dirname, '../fixtures/media-history.mp4'),
        '-c', 'copy', '-metadata', `comment=media-history ${run} ${i}`, out]);
      return out;
    });
    await page.route('**/assets/video-presentation?*', async (route) => {
      const url = new URL(route.request().url()).searchParams.get('url') ?? '';
      if (urls.length > 0 && url !== urls[0]) await gate(url).opened;
      await route.continue();
    });
    await roomForUploads(files.length);
    const upload = async (file: string): Promise<[string, string]> => {
      const before = new Set((await nodeContents(page, projectId, spaceId)).keys());
      await page.locator('input[data-testid="canvas-upload-input"][multiple]').setInputFiles(file);
      let made: [string, string] = ['', ''];
      await expect.poll(async () => {
        const entries = [...(await nodeContents(page, projectId, spaceId)).entries()];
        made = entries.find(([id, content]) => !before.has(id) && /^https?:\/\//.test(content)) ?? ['', ''];
        return made[0];
      }, { timeout: 120_000, intervals: [1_000] }).not.toBe('');
      return made;
    };
    const [nodeId, first] = await upload(files[0]!);
    urls.push(first);
    for (const file of files.slice(1)) {
      const [extra, url] = await upload(file);
      urls.push(url);
      // Only the player stays; the clip's asset stays registered without its node.
      await page.evaluate(async ({ at, pid, sid, id }) => {
        const canvas = await import(/* @vite-ignore */ at);
        canvas.removeNode(pid, sid, id);
      }, { at: canvasAt, pid: projectId, sid: spaceId, id: extra });
    }
    // Only the history listing is a fixture. Uploads, presentations,
    // restoration, Yjs, player DOM, decoding and clicks are the real paths.
    await page.route(`**/canvas/nodes/${nodeId}/history?*`, (route) =>
      route.fulfill({ json: { data: { total: 3, entries: urls.map((content, i) => ({
        id: `history-${i}`, entryType: 'upload', status: 'success', content,
        thumbnailUrl: null, errorMessage: null, operatorName: null,
        metadata: { filename: `clip-${i}.mp4` }, createdAt: '2026-09-22T00:00:00Z',
      })) } } }));
    const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
    // The renderer's element, tagged with the canonical URL it presents.
    const media = node.getByTestId('media-element');
    const toggle = node.getByTestId('play-toggle');
    await expect(media).toHaveAttribute('data-canonical-video-display', urls[0]!, { timeout: 120_000 });
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(2);
    await toggle.click();
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
    await node.click({ button: 'right' });
    await page.getByTestId('node-menu-history').click();
    for (const index of [1, 2, 0]) {
      if (index === 2) gate(urls[2]!).open();
      await page.getByTestId('node-history-row').filter({ hasText: `clip-${index}.mp4` })
        .getByTestId('node-history-restore').click();
      if (index === 1) {
        // While the restored clip is still preparing there is nothing to
        // start: no renderer, and Play offered but unavailable.
        await expect(media).toHaveCount(0);
        await expect(toggle).toBeDisabled();
        await expect(toggle).toHaveAttribute('aria-label', 'Play');
        gate(urls[1]!).open();
      }
      await expect(media).toHaveAttribute('data-canonical-video-display', urls[index]!, { timeout: 120_000 });
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
      await expect(toggle).toHaveAttribute('aria-label', 'Play');
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.readyState)).toBeGreaterThanOrEqual(2);
      await toggle.click();
      await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
      await expect(toggle).toHaveAttribute('aria-label', 'Pause');
    }
    await toggle.click();
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    await expect(toggle).toHaveAttribute('aria-label', 'Play');
    // Replacing an already paused resource must not start it either.
    await page.getByTestId('node-history-row').filter({ hasText: 'clip-1.mp4' })
      .getByTestId('node-history-restore').click();
    await expect(media).toHaveAttribute('data-canonical-video-display', urls[1]!);
    await expect(toggle).toHaveAttribute('aria-label', 'Play');
    await toggle.click();
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(0);
    await expect(page).toHaveURL(initialUrl);
  } finally {
    for (const entry of gates.values()) entry.open();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await deleteSpace(page, spaceId);
    rmSync(dir, { recursive: true, force: true });
  }
});
