// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Native buffering at the Timeline clock boundary (inner#1707). */
import { writeFileSync } from 'node:fs';
import type { ProjectRegisteredAsset } from '@breatic/shared';
import { expect, type Page, type Route } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { timelineVideoOf, uploadTimelineVideo, watchTimelineErrors, type TimelineUpload } from '../helpers/timeline-media';
import { startTimelineRange, type TimelineRange } from '../helpers/timeline-range';

/** One real native-video and Timeline-clock observation. */
interface TransportSample { at: number; time: number; frame: number; readyState: number; paused: boolean; ended: boolean; waitingEvents: number; error: number | null }

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Persist numeric evidence even with Playwright's list reporter.
 * @throws {Error} When the test output cannot be written or attached.
 */
async function saveEvidence(name: string, evidence: unknown): Promise<void> {
  const path = test.info().outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(evidence, null, 2), 'utf8');
  await test.info().attach(name, { path, contentType: 'application/json' });
}

/**
 * Capture the actual HTTP byte delivery and the placement's current native state, including first-frame failures.
 * @param clipId - The uploaded placement, or null before the upload has one.
 * @throws {Error} When the numeric evidence cannot be written or attached.
 */
async function saveFixtureEvidence(page: Page, range: TimelineRange, name: string, clipId: string | null): Promise<void> {
  const native = page.isClosed() ? { pageClosed: true } : await page.evaluate(({ fixtureUrl, clipId }) => {
    const root = document.querySelector('[data-space-outlet]:not([style*="display: none"])');
    const video = clipId === null ? null : root?.querySelector<HTMLVideoElement>(`[data-testid="timeline-preview"] video[data-clip-id="${clipId}"]`);
    if (video === undefined || video === null) return { mediaPresent: false };
    return {
      mediaPresent: true, usesLoopbackFixture: video.currentSrc === fixtureUrl,
      currentTime: video.currentTime, duration: video.duration,
      readyState: video.readyState, networkState: video.networkState,
      paused: video.paused, ended: video.ended, seeking: video.seeking,
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, error: video.error?.code ?? null,
      waitingEvents: Number(video.getAttribute('data-test-native-waiting') ?? '0'),
      buffered: Array.from({ length: video.buffered.length }, (_, index) => ({ start: video.buffered.start(index), end: video.buffered.end(index) })),
      seekable: Array.from({ length: video.seekable.length }, (_, index) => ({ start: video.seekable.start(index), end: video.seekable.end(index) })),
      timelineFrame: Number(root?.querySelector('[role="slider"]')?.getAttribute('aria-valuenow') ?? '0'),
      playControl: root?.querySelector('[data-testid="timeline-play"]')?.textContent ?? null,
    };
  }, { fixtureUrl: range.url, clipId }).catch((error: unknown) => ({ snapshotUnavailable: true, errorName: error instanceof Error ? error.name : 'UnknownError' }));
  await saveEvidence(name, {
    fixture: {
      name: 'mini-tools/driving.mp4', sizeBytes: range.sizeBytes, holdStart: range.holdStart,
      complete32KiBPrefixBlocks: Math.floor(range.holdStart / 32768),
      rangeRequests: range.rangeRequests, heldResponses: range.heldResponses,
      prefixBytesFlushed: range.prefixBytesFlushed, bodyBytesFlushed: range.bodyBytesFlushed,
      requests: range.requests, errors: range.errors,
    },
    native,
  });
}

/**
 * Read the placement's actual DOM/native facts on consecutive browser animation frames for a bounded interval.
 * @throws {Error} When the placement's native video or the frame control is absent.
 */
async function sampleTransport(page: Page, clipId: string, milliseconds = 350): Promise<TransportSample[]> {
  return visibleSpace(page).evaluate(async (root, { duration, clipId }) => {
    const video = root.querySelector<HTMLVideoElement>(`[data-testid="timeline-preview"] video[data-clip-id="${clipId}"]`);
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
  }, { duration: milliseconds, clipId });
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
  let clipId: string | null = null;
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
    const uploaded = await uploadTimelineVideo(page, projectId, range.fixturePath);
    clipId = uploaded.clipId;
    await saveFixtureEvidence(page, range, 'native-first-frame', clipId);
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
      await saveFixtureEvidence(page, range, 'native-final-snapshot', clipId);
    } finally {
      try {
        if (spaceId !== null) await deleteSpace(page, spaceId);
      } finally {
        try {
          await page.unroute(pattern, locateMedia);
        } finally {
          await range.close();
        }
      }
    }
  }
}

/**
 * Play real decoded bytes and wait for native starvation after observable clock advancement.
 * @throws {Error} When native playback, genuine waiting or the Timeline waiting state never appears.
 */
async function enterNativeWaiting(page: Page, uploaded: TimelineUpload, range: TimelineRange): Promise<TransportSample[]> {
  const outlet = visibleSpace(page);
  const video = timelineVideoOf(page, uploaded.clipId);
  await video.evaluate((element: HTMLVideoElement) => {
    element.setAttribute('data-test-native-waiting', '0');
    // Observe browser events only; no synthetic event or media-property assignment.
    element.addEventListener('waiting', () => {
      element.setAttribute('data-test-native-waiting', String(Number(element.getAttribute('data-test-native-waiting')) + 1));
    });
  });
  await outlet.getByTestId('timeline-play').click();
  await expect(outlet.locator('[data-playback-state]')).toHaveAttribute('data-playback-state', 'playing');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0.25);
  const advancing = await sampleTransport(page, uploaded.clipId);
  expect(advancing.at(-1)!.time).toBeGreaterThan(advancing[0].time);
  expect(advancing.at(-1)!.frame).toBeGreaterThan(advancing[0].frame);
  const earlierWaitingEvents = advancing.at(-1)!.waitingEvents;
  await expect.poll(() => range.heldResponses).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
    starved: element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !element.ended && element.currentTime > 1,
    waitingEvents: Number(element.getAttribute('data-test-native-waiting')),
  })), { timeout: 20_000 }).toMatchObject({ starved: true, waitingEvents: expect.any(Number) });
  await expect(outlet.getByText('Buffering…', { exact: true })).toBeVisible();
  const waiting = await sampleTransport(page, uploaded.clipId);
  expect(waiting.length).toBeGreaterThan(2);
  expect(waiting[0].waitingEvents).toBeGreaterThan(earlierWaitingEvents);
  expect(waiting.every((sample) => sample.readyState < 3 && !sample.ended && sample.error === null)).toBe(true);
  expect(new Set(waiting.map((sample) => sample.frame))).toEqual(new Set([waiting[0].frame]));
  expect(Math.max(...waiting.map((sample) => sample.time)) - Math.min(...waiting.map((sample) => sample.time))).toBeLessThan(uploaded.fps.den / uploaded.fps.num);
  expect(waiting[0].frame).toBeGreaterThan(0);
  expect(waiting[0].frame).toBeLessThan(uploaded.durationFrames - 1);
  await saveEvidence('native-playing-then-waiting', { fps: uploaded.fps, advancing, waiting });
  await saveFixtureEvidence(page, range, 'native-waiting-byte-delivery', uploaded.clipId);
  return waiting;
}

test('native starvation freezes the Timeline clock and releasing the same HTTP range resumes it @needs-storage @needs-ingest', async ({ page }) => {
  await withBufferingTimeline(page, async (uploaded, range) => {
    const waiting = await enterNativeWaiting(page, uploaded, range);
    range.release();
    const outlet = visibleSpace(page);
    await expect(outlet.locator('[data-playback-state]')).toHaveAttribute('data-playback-state', 'playing');
    await expect.poll(async () => (await sampleTransport(page, uploaded.clipId, 50)).at(-1)!.time).toBeGreaterThan(waiting.at(-1)!.time + 0.2);
    const resumed = await sampleTransport(page, uploaded.clipId);
    expect(resumed.every((sample) => !sample.paused && sample.readyState >= 3 && sample.error === null)).toBe(true);
    expect(resumed[0].frame).toBeGreaterThan(waiting.at(-1)!.frame);
    expect(resumed.at(-1)!.time).toBeGreaterThan(resumed[0].time);
    expect(resumed.at(-1)!.frame).toBeGreaterThan(resumed[0].frame);
    await saveEvidence('native-resumed', { fps: uploaded.fps, resumed });
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.locator('[data-playback-state]')).toHaveAttribute('data-playback-state', 'paused');
  });
});

test('pausing during native starvation keeps the Timeline paused when held HTTP bytes arrive @needs-storage @needs-ingest', async ({ page }) => {
  await withBufferingTimeline(page, async (uploaded, range) => {
    await enterNativeWaiting(page, uploaded, range);
    const outlet = visibleSpace(page);
    const video = timelineVideoOf(page, uploaded.clipId);
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Pause');
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    await expect(outlet.locator('[data-playback-state]')).toHaveAttribute('data-playback-state', 'paused');
    const paused = await sampleTransport(page, uploaded.clipId);
    range.release();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(3);
    const afterRelease = await sampleTransport(page, uploaded.clipId);
    expect(afterRelease.length).toBeGreaterThan(2);
    expect(afterRelease.every((sample) => sample.paused && sample.error === null)).toBe(true);
    expect(new Set([...paused, ...afterRelease].map((sample) => sample.frame))).toEqual(new Set([paused[0].frame]));
    expect(afterRelease.at(-1)!.time).toBeCloseTo(paused[0].time, 6);
    await expect(outlet.locator('[data-playback-state]')).toHaveAttribute('data-playback-state', 'paused');
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    await saveEvidence('native-paused-across-release', { fps: uploaded.fps, paused, afterRelease });
  });
});
