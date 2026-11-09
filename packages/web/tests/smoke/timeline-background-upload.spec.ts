// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Background Timeline work (#1434): a local video is placed at once and uploads behind the closed dialog, and the
 * Timeline tab spins while an upload or an execution runs, whether or not the Space is shown.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { roomForUploads } from '../helpers/upload-budget';
import {
  expectTimelineVideoReady, moveTimelineClip, openTimeline, selectTimelineClip, timelineClipIds, uploadTimelineVideo, withTimelinePeer,
} from '../helpers/timeline-media';

const FIXTURE = resolve(__dirname, '../fixtures/media-history.mp4');
const TICKET = '**/api/v1/assets/upload-ticket';
const CONVERTED_MS = 120_000;

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Hold every upload ticket request until the returned release is called.
 * @returns The release.
 * @throws {never} Never.
 */
async function holdUploads(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => { release = done; });
  await page.route(TICKET, async (route: Route) => {
    await held;
    // openSmokeProject watches this endpoint too; the request goes on to that handler.
    await route.fallback();
  });
  return release;
}

/**
 * Confirm a local video in the visible Timeline's Add media dialog, and wait for the dialog to close.
 * @returns The placeholder's clip id.
 * @throws {Error} When the dialog stays open or no placeholder appears.
 */
async function placeLocalVideo(page: Page): Promise<string> {
  const outlet = visibleSpace(page);
  const before = new Set(await timelineClipIds(page));
  await outlet.getByTestId('timeline-add-media').click();
  const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
  await dialog.getByTestId('timeline-material-local').click();
  await dialog.getByTestId('timeline-file-input').setInputFiles({ name: `background-${crypto.randomUUID()}.mp4`, mimeType: 'video/mp4', buffer: readFileSync(FIXTURE) });
  await dialog.getByTestId('timeline-confirm-material').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await timelineClipIds(page)).filter((id) => !before.has(id)).length).toBe(1);
  const [clipId] = (await timelineClipIds(page)).filter((id) => !before.has(id));
  await expect(outlet.getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-kind', 'upload');
  return clipId!;
}

/**
 * Turn a Timeline editing switch on or off.
 * @throws {Error} When the switch does not take the state.
 */
async function setSwitch(page: Page, testId: string, on: boolean): Promise<void> {
  const toggle = visibleSpace(page).getByTestId(testId);
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
}

/**
 * Wait until the preview's native video at the playhead has decoded a frame of whatever it plays.
 * @throws {Error} When no video decodes.
 */
async function expectPreviewDecodes(page: Page): Promise<void> {
  const video = visibleSpace(page).getByTestId('timeline-preview').locator('video');
  await expect(video).toHaveAttribute('src', /^https?:/, { timeout: CONVERTED_MS });
  await expectTimelineVideoReady(page, (await video.getAttribute('src'))!);
}

test('a local video uploads behind the closed dialog, spins the tab, holds the close and becomes a playable video @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline background ${crypto.randomUUID()}`);
  const spaces = [spaceId];
  try {
    const first = await uploadTimelineVideo(page, projectId);
    await setSwitch(page, 'timeline-toggle-magnet', true);
    await roomForUploads(1);
    const release = await holdUploads(page);
    const clipId = await placeLocalVideo(page);
    const outlet = visibleSpace(page);
    await expect(outlet.getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-state', 'uploading');
    await expect(page.getByTestId(`space-tab-busy-${spaceId}`)).toBeVisible();
    // Editing goes on while the upload runs: the first clip moves to a new track and the main track closes up.
    await moveTimelineClip(page, first.clipId, 0, first.durationFrames, 'New visual track');
    await selectTimelineClip(page, clipId);
    await expect(outlet.getByTestId('timeline-clip-upload')).toBeVisible();

    // Another Space in front: the Timeline tab keeps spinning and closing it is held.
    spaces.push(await createSpace(page, 'canvas', `Canvas beside ${crypto.randomUUID()}`));
    await expect(page.getByTestId(`space-tab-busy-${spaceId}`)).toBeVisible();
    const tab = page.getByTestId(`space-tab-${spaceId}`);
    await tab.hover();
    await page.getByTestId(`space-tab-close-${spaceId}`).click();
    await expect(page.getByText(/still in progress/)).toBeVisible();
    await expect(tab).toBeVisible();

    release();
    await page.unroute(TICKET);
    await expect(page.getByTestId(`space-tab-busy-${spaceId}`)).toHaveCount(0, { timeout: CONVERTED_MS });
    await openTimeline(page, spaceId);
    await expect(visibleSpace(page).getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-kind', 'video', { timeout: CONVERTED_MS });
    await selectTimelineClip(page, first.clipId);
    await visibleSpace(page).getByTestId('timeline-delete').click();
    await expect(visibleSpace(page).getByTestId(`timeline-clip-${first.clipId}`)).toHaveCount(0);
    await expectPreviewDecodes(page);
  } finally {
    for (const id of spaces.reverse()) await deleteSpace(page, id);
  }
});

test('a failed upload keeps its placeholder, says why and lands on retry @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline upload retry ${crypto.randomUUID()}`);
  try {
    await page.route(TICKET, (route) => route.fulfill({ status: 500, body: '{}' }));
    const clipId = await placeLocalVideo(page);
    const outlet = visibleSpace(page);
    await expect(outlet.getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
    await expect(page.getByTestId(`space-tab-busy-${spaceId}`)).toHaveCount(0);
    await selectTimelineClip(page, clipId);
    await expect(outlet.getByTestId('timeline-clip-upload')).toBeVisible();
    await page.unroute(TICKET);
    await roomForUploads(1);
    await outlet.getByTestId('timeline-upload-retry').click();
    await expect(outlet.getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-kind', 'video', { timeout: CONVERTED_MS });
    await expectPreviewDecodes(page);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('a collaborator sees the upload running, then unfinished once the uploader leaves, and deletes it @needs-storage @needs-ingest', async ({ page, browser }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline peer upload ${crypto.randomUUID()}`);
  try {
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
      await peer.goto(page.url());
      await openTimeline(peer, spaceId);
      await holdUploads(peer);
      const clipId = await placeLocalVideo(peer);
      const seen = visibleSpace(page).getByTestId(`timeline-clip-${clipId}`);
      await expect(seen).toHaveAttribute('data-state', 'uploading');
      await expect(seen).toContainText('Uploading');
      await peer.close();
      // The uploader's awareness lapses once its page is gone.
      await expect(seen).toHaveAttribute('data-state', 'unfinished', { timeout: 60_000 });
      await expect(seen).toContainText('Unfinished');
      await selectTimelineClip(page, clipId);
      await visibleSpace(page).getByTestId('timeline-delete').click();
      await expect(seen).toHaveCount(0);
    });
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('the Timeline tab spins while one of its executions runs, with another Space in front', async ({ page }) => {
  await openSmokeProject(page);
  let status = 'running';
  // The tab bar reads the list as soon as the Timeline tab exists, so the answer is shaped before the Space is made.
  await page.route('**/api/v1/timeline/executions?*', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch();
    const now = new Date().toISOString();
    const row = {
      id: '90000000-0000-4000-8000-000000000001', projectId: url.searchParams.get('projectId'), spaceId: url.searchParams.get('spaceId'),
      actorUserId: 'someone', kind: 'web_animation_create', actionId: 'a0000000-0000-4000-8000-000000000001', input: {}, inputHash: 'sha256:smoke',
      engine: 'deepseek', status, phase: null, steps: [], attempt: 1, fence: null, deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      resultSourceVersionId: null, failureReason: null, billedCredits: null, billedAt: null, createdAt: now, updatedAt: now, usageCredits: 0,
    };
    await route.fulfill({ response, json: { data: [row] } });
  });
  const spaceId = await createSpace(page, 'timeline', `Timeline execution spinner ${crypto.randomUUID()}`);
  const spaces = [spaceId];
  try {
    spaces.push(await createSpace(page, 'canvas', `Canvas in front ${crypto.randomUUID()}`));
    await expect(page.getByTestId(`space-tab-busy-${spaceId}`)).toBeVisible();
    status = 'succeeded';
    // The tab bar reads the list again at the configured interval while a row is unfinished.
    await expect(page.getByTestId(`space-tab-busy-${spaceId}`)).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await page.unroute('**/api/v1/timeline/executions?*');
    for (const id of spaces.reverse()) await deleteSpace(page, id);
  }
});
