// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Real registered video, permissions and concurrent Timeline arrangement (inner#1707). */
import { expect } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import {
  addProjectTimelineVideo,
  expectTimelineStart,
  expectTimelineVideoReady,
  moveTimelineClip,
  openTimeline,
  setTimelineConnection,
  timelineClipIds,
  uploadTimelineVideo,
  watchTimelineErrors,
  withTimelinePeer,
} from '../helpers/timeline-media';

test.use({ viewport: { width: 1680, height: 1100 } });

test('local video and its Project copy play, pause, seek and survive closing the Timeline @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline video ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const duplicateId = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    expect(duplicateId).not.toBe(uploaded.clipId);
    await expectTimelineStart(page, uploaded.clipId, 0, uploaded.durationFrames);
    await expectTimelineStart(page, duplicateId, uploaded.durationFrames, uploaded.durationFrames);
    await expect(visibleSpace(page).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);

    const outlet = visibleSpace(page);
    const slider = outlet.getByRole('slider', { name: 'Preview frame', exact: true });
    const video = outlet.getByTestId('timeline-preview').locator('video');
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await expectTimelineVideoReady(page, uploaded.asset.fileUrl);
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Pause');
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);
    await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();

    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    await expect(outlet.getByText('Paused', { exact: true })).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
    const pausedFrame = await slider.getAttribute('aria-valuenow');
    const pausedTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
    // An immediate read cannot prove that pause stays effective across actual browser animation frames.
    const observed = await slider.evaluate(async (thumb) => {
      const frames: (string | null)[] = [];
      const until = performance.now() + 350;
      do {
        frames.push(thumb.getAttribute('aria-valuenow'));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      } while (performance.now() < until);
      return frames;
    });
    expect(observed.length).toBeGreaterThan(2);
    expect(new Set(observed)).toEqual(new Set([pausedFrame]));
    expect(await video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(pausedTime, 6);

    await slider.focus();
    await slider.press('Home');
    // Radix PageUp advances ten integer-frame steps through the same onValueChange as pointer seeking.
    await slider.press('PageUp');
    await slider.press('PageUp');
    await slider.press('PageUp');
    await expect(slider).toHaveAttribute('aria-valuenow', '30');
    const targetSeconds = 30 * uploaded.fps.den / uploaded.fps.num;
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeCloseTo(targetSeconds, 2);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused && !element.seeking)).toBe(true);
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');

    await page.getByTestId(`space-tab-${spaceId}`).hover();
    await page.getByTestId(`space-tab-close-${spaceId}`).click();
    await expect(page.getByTestId(`space-tab-name-${spaceId}`)).toHaveCount(0);
    await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toHaveCount(0);
    await openTimeline(page, spaceId);
    await expect.poll(() => timelineClipIds(page)).toEqual([uploaded.clipId, duplicateId]);
    await expectTimelineStart(page, uploaded.clipId, 0, uploaded.durationFrames);
    await expectTimelineStart(page, duplicateId, uploaded.durationFrames, uploaded.durationFrames);
    await expectTimelineVideoReady(page, uploaded.asset.fileUrl);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('a real Viewer sees the registered Timeline clips without material or start-frame editing @needs-storage @needs-ingest', async ({ page, browser }) => {
  const ownerErrors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline viewer ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    ownerErrors.mediaUrls.add(uploaded.asset.fileUrl);
    const duplicateId = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    await withTimelinePeer(page, browser, projectId, 'viewer', async (peer) => {
      const errors = watchTimelineErrors(peer);
      errors.mediaUrls.add(uploaded.asset.fileUrl);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      await expect.poll(() => timelineClipIds(peer)).toEqual([uploaded.clipId, duplicateId]);
      await expectTimelineVideoReady(peer, uploaded.asset.fileUrl);
      await expectTimelineStart(peer, uploaded.clipId, 0, uploaded.durationFrames);
      await expectTimelineStart(peer, duplicateId, uploaded.durationFrames, uploaded.durationFrames);
      const outlet = visibleSpace(peer);
      // Synchronized placements and resolved media anchor the read-only absence checks.
      await expect(outlet.getByTestId('timeline-add-media')).toHaveCount(0);
      await expect(outlet.getByTestId('timeline-edit-start')).toHaveCount(0);
      await expect(outlet.getByTestId('timeline-start-frame')).toHaveCount(0);
      await expect(outlet.getByTestId('timeline-play')).toBeEnabled();
      await outlet.getByTestId('timeline-play').click();
      await expect.poll(() => outlet.getByTestId('timeline-preview').locator('video').evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);
      await outlet.getByTestId('timeline-play').click();
      await expect.poll(() => outlet.getByTestId('timeline-preview').locator('video').evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
      await expect.poll(() => timelineClipIds(page)).toEqual([uploaded.clipId, duplicateId]);
      expect(errors.unexpected).toEqual([]);
    });
    expect(ownerErrors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('two Editors retain independent offline moves, see the merged overlap and repair it through start-frame editing @needs-storage @needs-ingest', async ({ page, browser }) => {
  const ownerErrors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline concurrent ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    ownerErrors.mediaUrls.add(uploaded.asset.fileUrl);
    const secondId = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    const duration = uploaded.durationFrames;
    const farStart = duration * 3;
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer, context) => {
      const peerErrors = watchTimelineErrors(peer);
      peerErrors.mediaUrls.add(uploaded.asset.fileUrl);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      await expect.poll(() => timelineClipIds(peer)).toEqual([uploaded.clipId, secondId]);
      for (const member of [page, peer]) {
        await expectTimelineVideoReady(member, uploaded.asset.fileUrl);
        await expectTimelineStart(member, uploaded.clipId, 0, duration);
        await expectTimelineStart(member, secondId, duration, duration);
        await expect(visibleSpace(member).getByTestId('timeline-edit-start')).toBeEnabled();
        await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
      }
      ownerErrors.offline = true;
      peerErrors.offline = true;
      try {
        await page.context().setOffline(true);
        await context.setOffline(true);
        await setTimelineConnection(page, projectId, spaceId, false);
        await setTimelineConnection(peer, projectId, spaceId, false);
        await moveTimelineClip(page, uploaded.clipId, farStart, duration);
        await expectTimelineStart(peer, uploaded.clipId, 0, duration);
        await moveTimelineClip(peer, secondId, farStart, duration);
        await expectTimelineStart(page, secondId, duration, duration);
        // Both branches are legal, retain both placements, and have not received the other's move.
        for (const member of [page, peer]) {
          await expect(visibleSpace(member).locator('[data-testid^="timeline-clip-"]')).toHaveCount(2);
          await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
        }
        await expectTimelineStart(page, uploaded.clipId, farStart, duration);
        await expectTimelineStart(peer, secondId, farStart, duration);
        await page.context().setOffline(false);
        await context.setOffline(false);
        await setTimelineConnection(page, projectId, spaceId, true);
        await setTimelineConnection(peer, projectId, spaceId, true);
        ownerErrors.offline = false;
        peerErrors.offline = false;
        for (const member of [page, peer]) {
          const outlet = visibleSpace(member);
          await expect(outlet.locator('[data-testid^="timeline-clip-"]')).toHaveCount(2);
          await expect(outlet.getByTestId(`timeline-conflict-${uploaded.clipId}`)).toContainText(`Start ${farStart} · Duration ${duration} frames`);
          await expect(outlet.getByTestId(`timeline-conflict-${secondId}`)).toContainText(`Start ${farStart} · Duration ${duration} frames`);
          expect((await timelineClipIds(member)).sort()).toEqual([uploaded.clipId, secondId].sort());
        }
        // Conflict rows keep overlapping placements reachable even when track buttons cover each other.
        await moveTimelineClip(page, secondId, farStart + duration, duration);
        for (const member of [page, peer]) {
          await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
          await expectTimelineStart(member, uploaded.clipId, farStart, duration);
          await expectTimelineStart(member, secondId, farStart + duration, duration);
          expect(await timelineClipIds(member)).toEqual([uploaded.clipId, secondId]);
        }
        expect(peerErrors.unexpected).toEqual([]);
      } finally {
        // Keep the owner's actual connection usable by the ordinary Space deletion helper on failure.
        await page.context().setOffline(false);
        await context.setOffline(false);
        await setTimelineConnection(page, projectId, spaceId, true);
      }
    });
    expect(ownerErrors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});
