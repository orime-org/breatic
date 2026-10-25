// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Native buffering at the Timeline clock boundary (inner#1707). */
import type { ProjectRegisteredAsset } from '@breatic/shared';
import { expect, type Page, type Route } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { uploadTimelineVideo, watchTimelineErrors, type TimelineUpload } from '../helpers/timeline-media';
import { startTimelineRange, type TimelineRange } from '../helpers/timeline-range';

/** One real native-video and Timeline-clock observation. */
interface TransportSample { at: number; time: number; frame: number; readyState: number; paused: boolean; ended: boolean; waitingEvents: number; error: number | null }

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Read actual DOM/native facts on consecutive browser animation frames for a bounded interval.
 * @throws {Error} When the active Timeline's native preview or frame control is absent.
 */
async function sampleTransport(page: Page, milliseconds = 350): Promise<TransportSample[]> {
  return visibleSpace(page).evaluate(async (root, duration) => {
    const video = root.querySelector<HTMLVideoElement>('[data-testid="timeline-preview"] video');
    const slider = root.querySelector<HTMLElement>('[role="slider"]');
    if (video === null || slider === null) throw new Error('the native Timeline transport is absent');
    const observations: TransportSample[] = [];
    const until = performance.now() + duration;
    do {
      observations.push({
        at: performance.now(), time: video.currentTime,
        frame: Number(slider.getAttribute('aria-valuenow')), readyState: video.readyState,
        paused: video.paused, ended: video.ended,
        waitingEvents: Number(video.getAttribute('data-test-native-waiting') ?? '0'),
        error: video.error?.code ?? null,
      });
      await new Promise<void>((accept) => requestAnimationFrame(() => accept()));
    } while (performance.now() < until);
    return observations;
  }, milliseconds);
}

/**
 * Upload and authorize through production paths, replacing only the authorized media location.
 *
 * R2 playback is exercised by timeline-video.spec.ts. Here the same uploaded fixture bytes
 * are served from loopback so starvation is controlled without modifying native media facts.
 * @throws {Error} When real upload, authorization, media decoding or cleanup fails.
 */
async function withBufferingTimeline(
  page: Page,
  run: (uploaded: TimelineUpload, range: TimelineRange) => Promise<void>,
): Promise<void> {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const range = await startTimelineRange();
  const pattern = `**/api/v1/projects/${projectId}/assets/*`;
  let spaceId: string | null = null;
  const authorization: { asset: ProjectRegisteredAsset | null } = { asset: null };
  /**
   * Preserve the actual authorized DTO and envelope, changing only fileUrl for transport control.
   * @throws {Error} When the real canonical asset cannot be authorized or does not match the fixture.
   */
  const locateMedia = async (route: Route): Promise<void> => {
    const response = await route.fetch();
    expect(response.status(), 'the real Project-scoped asset authorization succeeds').toBe(200);
    const envelope = await response.json() as { data: ProjectRegisteredAsset };
    const asset = envelope.data;
    expect(asset.assetId).toBe(new URL(route.request().url()).pathname.split('/').at(-1));
    expect(asset.projectReferenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(asset.kind).toBe('video');
    expect(asset.sizeBytes).toBe(range.sizeBytes);
    expect(asset.mimeType).toBe('video/mp4');
    expect(new URL(asset.fileUrl).protocol).toMatch(/^https?:$/);
    expect(asset.fileUrl).not.toBe(range.url);
    if (authorization.asset === null) authorization.asset = asset;
    else expect(asset).toEqual(authorization.asset);
    await route.fulfill({ response, json: { ...envelope, data: { ...asset, fileUrl: range.url } } });
  };
  try {
    await page.route(pattern, locateMedia);
    spaceId = await createSpace(page, 'timeline', `Timeline buffering ${crypto.randomUUID()}`);
    const uploaded = await uploadTimelineVideo(page, projectId);
    const canonicalAsset = authorization.asset;
    if (canonicalAsset === null) throw new Error('the uploaded video was not authorized through its Project');
    expect(uploaded.asset).toEqual({ ...canonicalAsset, fileUrl: range.url });
    errors.mediaUrls.add(range.url);
    await run(uploaded, range);
    expect(range.rangeRequests).toBeGreaterThan(0);
    expect(range.heldResponses).toBeGreaterThan(0);
    expect(range.errors).toEqual([]);
    expect(errors.unexpected).toEqual([]);
  } finally {
    try {
      if (spaceId !== null) await deleteSpace(page, spaceId);
    } finally {
      await page.unroute(pattern, locateMedia);
      await range.close();
    }
  }
}

/**
 * Play real decoded bytes and wait for native starvation after observable clock advancement.
 * @throws {Error} When native playback, genuine waiting or the Timeline waiting state never appears.
 */
async function enterNativeWaiting(page: Page, uploaded: TimelineUpload, range: TimelineRange): Promise<TransportSample[]> {
  const outlet = visibleSpace(page);
  const video = outlet.getByTestId('timeline-preview').locator('video');
  await video.evaluate((element: HTMLVideoElement) => {
    element.setAttribute('data-test-native-waiting', '0');
    // Observe browser events only; no synthetic event or media-property assignment.
    element.addEventListener('waiting', () => {
      element.setAttribute('data-test-native-waiting', String(Number(element.getAttribute('data-test-native-waiting')) + 1));
    });
  });
  await outlet.getByTestId('timeline-play').click();
  await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.25);
  const advancing = await sampleTransport(page);
  expect(advancing.at(-1)!.time).toBeGreaterThan(advancing[0].time);
  expect(advancing.at(-1)!.frame).toBeGreaterThan(advancing[0].frame);
  const earlierWaitingEvents = advancing.at(-1)!.waitingEvents;
  await expect.poll(() => range.heldResponses).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
    starved: element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !element.ended && element.currentTime > 1,
    waitingEvents: Number(element.getAttribute('data-test-native-waiting')),
  })), { timeout: 20_000 }).toMatchObject({ starved: true, waitingEvents: expect.any(Number) });
  await expect(outlet.getByText('Buffering…', { exact: true })).toBeVisible();
  const waiting = await sampleTransport(page);
  expect(waiting.length).toBeGreaterThan(2);
  expect(waiting[0].waitingEvents).toBeGreaterThan(earlierWaitingEvents);
  expect(waiting.every((sample) => sample.readyState < 3 && !sample.ended && sample.error === null)).toBe(true);
  expect(new Set(waiting.map((sample) => sample.frame))).toEqual(new Set([waiting[0].frame]));
  expect(Math.max(...waiting.map((sample) => sample.time)) - Math.min(...waiting.map((sample) => sample.time))).toBeLessThan(uploaded.fps.den / uploaded.fps.num);
  expect(waiting[0].frame).toBeGreaterThan(0);
  expect(waiting[0].frame).toBeLessThan(uploaded.durationFrames - 1);
  await test.info().attach('native-playing-then-waiting', {
    body: JSON.stringify({ fps: uploaded.fps, advancing, waiting }), contentType: 'application/json',
  });
  return waiting;
}

test('native starvation freezes the Timeline clock and releasing the same HTTP range resumes it @needs-storage @needs-ingest', async ({ page }) => {
  await withBufferingTimeline(page, async (uploaded, range) => {
    const waiting = await enterNativeWaiting(page, uploaded, range);
    range.release();
    const outlet = visibleSpace(page);
    await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();
    await expect.poll(async () => (await sampleTransport(page, 50)).at(-1)!.time).toBeGreaterThan(waiting.at(-1)!.time + 0.2);
    const resumed = await sampleTransport(page);
    expect(resumed.every((sample) => !sample.paused && sample.readyState >= 3 && sample.error === null)).toBe(true);
    expect(resumed[0].frame).toBeGreaterThan(waiting.at(-1)!.frame);
    expect(resumed.at(-1)!.time).toBeGreaterThan(resumed[0].time);
    expect(resumed.at(-1)!.frame).toBeGreaterThan(resumed[0].frame);
    await test.info().attach('native-resumed', { body: JSON.stringify({ fps: uploaded.fps, resumed }), contentType: 'application/json' });
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByText('Paused', { exact: true })).toBeVisible();
  });
});

test('pausing during native starvation keeps the Timeline paused when held HTTP bytes arrive @needs-storage @needs-ingest', async ({ page }) => {
  await withBufferingTimeline(page, async (uploaded, range) => {
    await enterNativeWaiting(page, uploaded, range);
    const outlet = visibleSpace(page);
    const video = outlet.getByTestId('timeline-preview').locator('video');
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Pause');
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    await expect(outlet.getByText('Paused', { exact: true })).toBeVisible();
    const paused = await sampleTransport(page);
    range.release();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(3);
    const afterRelease = await sampleTransport(page);
    expect(afterRelease.length).toBeGreaterThan(2);
    expect(afterRelease.every((sample) => sample.paused && sample.error === null)).toBe(true);
    expect(new Set([...paused, ...afterRelease].map((sample) => sample.frame))).toEqual(new Set([paused[0].frame]));
    expect(afterRelease.at(-1)!.time).toBeCloseTo(paused[0].time, 6);
    await expect(outlet.getByText('Paused', { exact: true })).toBeVisible();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    await test.info().attach('native-paused-across-release', { body: JSON.stringify({ fps: uploaded.fps, paused, afterRelease }), contentType: 'application/json' });
  });
});
