// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from 'playwright/test';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';

// Real decoded media; both tracks are present so audio and video exercise the
// native load algorithm. Generated once with ffmpeg (64x48 blue + silent AAC,
// 15 seconds); no external service or ffmpeg installation is needed to run.
const clip = readFileSync(resolve(__dirname, '../fixtures/media-history.mp4'));

test.use({ viewport: { width: 1680, height: 1100 } });

for (const kind of ['audio', 'video'] as const) {
  test(`${kind}: history replacement leaves a playable resource`, async ({ page }) => {
    await openSmokeProject(page);
    const projectId = smokeProjectId();
    const initialUrl = page.url();
    const spaceId = await createSpace(page, 'canvas', `media-history-${kind}-${Date.now()}`);
    try {
      await expect(page.locator('.react-flow')).toBeVisible();
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
      const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
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
