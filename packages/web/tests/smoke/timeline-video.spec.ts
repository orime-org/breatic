// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Real registered video, permissions and concurrent Timeline arrangement (inner#1707). */
import { expect, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { flushTimelineDelivery, installTimelineDeliveryGate } from '../helpers/timeline-delivery';
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

/**
 * Assert that the existing Project connection policy still permits normal UI interaction.
 * @throws {Error} When a disconnection, auth failure or workspace curtain appears.
 */
async function expectTimelineConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('connection-banner')).toHaveCount(0);
  await expect(page.getByTestId('workspace-disabled-overlay')).toHaveCount(0);
  await expect(visibleSpace(page).getByTestId('timeline-add-media')).toBeEnabled();
}

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

test('two connected Editors merge concurrent moves into a visible overlap and repair it through conflict rows @needs-storage @needs-ingest', async ({ page, browser }) => {
  const ownerErrors = watchTimelineErrors(page);
  const ownerDelivery = await installTimelineDeliveryGate(page);
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
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
      const peerErrors = watchTimelineErrors(peer);
      peerErrors.mediaUrls.add(uploaded.asset.fileUrl);
      const peerDelivery = await installTimelineDeliveryGate(peer);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      await expect.poll(() => timelineClipIds(peer)).toEqual([uploaded.clipId, secondId]);
      for (const member of [page, peer]) {
        await expectTimelineVideoReady(member, uploaded.asset.fileUrl);
        await expectTimelineStart(member, uploaded.clipId, 0, duration);
        await expectTimelineStart(member, secondId, duration, duration);
        await expectTimelineConnected(member);
        await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
      }
      ownerDelivery.holding = true;
      peerDelivery.holding = true;
      try {
        await moveTimelineClip(page, uploaded.clipId, farStart, duration);
        await expectTimelineStart(peer, uploaded.clipId, 0, duration);
        await moveTimelineClip(peer, secondId, farStart, duration);
        await expectTimelineStart(page, secondId, duration, duration);
        // Each edit used the same initial layout; both sockets still send real updates to the server.
        await expect.poll(() => ownerDelivery.pending.length).toBeGreaterThan(0);
        await expect.poll(() => peerDelivery.pending.length).toBeGreaterThan(0);
        for (const member of [page, peer]) {
          await expectTimelineConnected(member);
          await expect(visibleSpace(member).locator('[data-testid^="timeline-clip-"]')).toHaveCount(2);
          await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
        }
        await expectTimelineStart(page, uploaded.clipId, farStart, duration);
        await expectTimelineStart(peer, secondId, farStart, duration);
        flushTimelineDelivery(ownerDelivery);
        flushTimelineDelivery(peerDelivery);
        for (const member of [page, peer]) {
          const outlet = visibleSpace(member);
          await expectTimelineConnected(member);
          await expect(outlet.getByTestId(`timeline-conflict-${uploaded.clipId}`)).toContainText(`Start ${farStart} · Duration ${duration} frames`);
          await expect(outlet.getByTestId(`timeline-conflict-${secondId}`)).toContainText(`Start ${farStart} · Duration ${duration} frames`);
          expect((await timelineClipIds(member)).sort()).toEqual([uploaded.clipId, secondId].sort());
        }
        // The conflict row reaches the selected placement without forcing clicks through an overlapping track button.
        await moveTimelineClip(page, secondId, farStart + duration, duration);
        for (const member of [page, peer]) {
          await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
          await expectTimelineStart(member, uploaded.clipId, farStart, duration);
          await expectTimelineStart(member, secondId, farStart + duration, duration);
          expect(await timelineClipIds(member)).toEqual([uploaded.clipId, secondId]);
        }
        expect(peerErrors.unexpected).toEqual([]);
      } finally {
        flushTimelineDelivery(ownerDelivery);
        flushTimelineDelivery(peerDelivery);
      }
    });
    expect(ownerErrors.unexpected).toEqual([]);
  } finally {
    flushTimelineDelivery(ownerDelivery);
    await deleteSpace(page, spaceId);
  }
});

test('a disconnected Editor keeps the Timeline behind the existing workspace curtain and resumes shared editing after reconnecting @needs-storage @needs-ingest', async ({ page, browser }) => {
  const ownerErrors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline reconnect ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    ownerErrors.mediaUrls.add(uploaded.asset.fileUrl);
    const secondId = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    const duration = uploaded.durationFrames;
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
      const peerErrors = watchTimelineErrors(peer);
      peerErrors.mediaUrls.add(uploaded.asset.fileUrl);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      await expect.poll(() => timelineClipIds(peer)).toEqual([uploaded.clipId, secondId]);
      for (const member of [page, peer]) {
        await expectTimelineVideoReady(member, uploaded.asset.fileUrl);
        await expectTimelineStart(member, uploaded.clipId, 0, duration);
        await expectTimelineStart(member, secondId, duration, duration);
        await expectTimelineConnected(member);
      }
      ownerErrors.offline = true;
      try {
        await page.context().setOffline(true);
        await setTimelineConnection(page, projectId, spaceId, false);
        await expect(page.getByTestId('connection-banner')).toHaveAttribute('data-status', 'disconnected');
        await expect(page.getByTestId('workspace-disabled-overlay')).toBeVisible();
        // Inspect retained content without interacting through the existing disconnection curtain.
        expect(await timelineClipIds(page)).toEqual([uploaded.clipId, secondId]);
        await expect(visibleSpace(page).getByText(`Start ${duration} · Duration ${duration} frames`, { exact: true })).toHaveCount(1);
        await expectTimelineConnected(peer);
        expect(await timelineClipIds(peer)).toEqual([uploaded.clipId, secondId]);
        await page.context().setOffline(false);
        await setTimelineConnection(page, projectId, spaceId, true);
        ownerErrors.offline = false;
        await expectTimelineConnected(page);
        for (const member of [page, peer]) {
          expect(await timelineClipIds(member)).toEqual([uploaded.clipId, secondId]);
          await expectTimelineStart(member, uploaded.clipId, 0, duration);
          await expectTimelineStart(member, secondId, duration, duration);
        }
        // Editing resumes only after the real connection and its normal Project policy are restored.
        await moveTimelineClip(page, uploaded.clipId, duration * 3, duration);
        await expectTimelineStart(peer, uploaded.clipId, duration * 3, duration);
        await moveTimelineClip(peer, secondId, duration * 4, duration);
        await expectTimelineStart(page, secondId, duration * 4, duration);
        for (const member of [page, peer]) {
          await expectTimelineConnected(member);
          await expect(visibleSpace(member).locator('[data-testid^="timeline-conflict-"]')).toHaveCount(0);
          expect(await timelineClipIds(member)).toEqual([uploaded.clipId, secondId]);
        }
        expect(peerErrors.unexpected).toEqual([]);
      } finally {
        await page.context().setOffline(false);
        await setTimelineConnection(page, projectId, spaceId, true);
      }
    });
    expect(ownerErrors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});
