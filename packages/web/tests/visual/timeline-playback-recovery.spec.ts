// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Timeline gap, conflict-boundary and native media recovery (inner#1707). */
import { writeFileSync } from 'node:fs';
import { expect, type Page, type Route } from 'playwright/test';

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
  timelineClipIds,
  uploadTimelineVideo,
  watchTimelineErrors,
  withTimelinePeer,
} from '../helpers/timeline-media';

/** Native and visible controller facts; no hidden production state is modified or inferred as measured. */
interface PlaybackReading {
  at: number;
  frame: number | null;
  playControl: string | null;
  reportedStates: string[];
  conflictCount: number;
  clipCount: number;
  native: null | {
    sameExpectedUrl: boolean | null;
    time: number;
    duration: number;
    readyState: number;
    networkState: number;
    paused: boolean;
    ended: boolean;
    seeking: boolean;
    width: number;
    errorCode: number | null;
  };
}

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Read the visible slider, reported controller state and real media facts over browser frames.
 * @throws {Error} When the page cannot evaluate the playback observations.
 */
async function observePlayback(page: Page, milliseconds = 0, expectedUrl: string | null = null): Promise<PlaybackReading[]> {
  return visibleSpace(page).evaluate(async (root, { duration, expected }) => {
    const readings: PlaybackReading[] = [];
    const until = performance.now() + duration;
    do {
      const video = root?.querySelector<HTMLVideoElement>('[data-testid="timeline-preview"] video');
      const slider = root?.querySelector('[role="slider"]');
      readings.push({
        at: performance.now(), frame: slider === undefined || slider === null ? null : Number(slider.getAttribute('aria-valuenow')),
        playControl: root?.querySelector('[data-testid="timeline-play"]')?.textContent ?? null,
        reportedStates: Array.from(root?.querySelectorAll('span') ?? []).map((span) => span.textContent ?? '').filter((text) => ['Playing', 'Paused', 'Buffering…', 'Playback failed'].includes(text)),
        conflictCount: root?.querySelectorAll('[data-testid^="timeline-conflict-"]').length ?? 0,
        clipCount: root?.querySelectorAll('[data-testid^="timeline-clip-"]').length ?? 0,
        native: video === undefined || video === null ? null : {
          sameExpectedUrl: expected === null ? null : video.currentSrc === expected,
          time: video.currentTime, duration: video.duration, readyState: video.readyState,
          networkState: video.networkState, paused: video.paused, ended: video.ended,
          seeking: video.seeking, width: video.videoWidth, errorCode: video.error?.code ?? null,
        },
      });
      if (duration === 0) break;
      await new Promise<void>((accept) => requestAnimationFrame(() => accept()));
    } while (performance.now() < until);
    return readings;
  }, { duration: milliseconds, expected: expectedUrl });
}

/**
 * Keep a screenshot and numeric evidence before the ordinary Space cleanup, including on failure.
 * @throws {Error} When evidence cannot be written or attached.
 */
async function preserveEvidence(page: Page, name: string, details: unknown): Promise<void> {
  const readings = page.isClosed() ? { pageClosed: true } : await observePlayback(page).catch((error: unknown) => ({
    snapshotError: error instanceof Error ? { name: error.name, message: error.message } : String(error),
  }));
  const image = test.info().outputPath(`${name}.png`);
  const json = test.info().outputPath(`${name}.json`);
  try {
    if (!page.isClosed()) {
      await page.screenshot({ path: image });
      await test.info().attach(name, { path: image, contentType: 'image/png' });
    }
  } finally {
    writeFileSync(json, JSON.stringify({ details, readings }, (_key, value: unknown) =>
      typeof value === 'string' ? value.replace(/https?:\/\/[^\s"')]+/g, '[redacted-url]') : value, 2), 'utf8');
    await test.info().attach(`${name}-numbers`, { path: json, contentType: 'application/json' });
  }
}

/**
 * Seek only through the existing native keyboard handlers of the Slider.
 * @throws {Error} When the real slider cannot accept the frame position.
 */
async function seekWithKeys(page: Page, frame: number): Promise<void> {
  const slider = visibleSpace(page).getByRole('slider', { name: 'Preview frame', exact: true });
  await slider.focus();
  await slider.press('Home');
  for (let index = 0; index < Math.floor(frame / 10); index += 1) await slider.press('PageUp');
  for (let index = 0; index < frame % 10; index += 1) await slider.press('ArrowRight');
}

/**
 * Close the actual tab and wait for its common Space lifecycle to remove the body.
 * @throws {Error} When the tab does not close.
 */
async function closeTimeline(page: Page, spaceId: string): Promise<void> {
  await page.getByTestId(`space-tab-${spaceId}`).hover();
  await page.getByTestId(`space-tab-close-${spaceId}`).click();
  await expect(page.getByTestId(`space-tab-name-${spaceId}`)).toHaveCount(0);
  await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toHaveCount(0);
}

test('playing continues after seeking inside the same empty gap @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline gap seek ${crypto.randomUUID()}`);
  const evidence: Record<string, unknown> = { clipStart: 240, target: 30 };
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    evidence.fps = uploaded.fps;
    evidence.durationFrames = uploaded.durationFrames;
    await moveTimelineClip(page, uploaded.clipId, 240, uploaded.durationFrames);
    const outlet = visibleSpace(page);
    const slider = outlet.getByRole('slider', { name: 'Preview frame', exact: true });
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    await expect(outlet.getByTestId('timeline-preview').locator('video')).toHaveCount(0);
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();
    await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    evidence.beforeSeek = await observePlayback(page, 150);
    await seekWithKeys(page, 30);
    const afterSeek = await observePlayback(page, 350);
    evidence.afterSeek = afterSeek;
    evidence.errors = errors.unexpected;
    expect(afterSeek.length).toBeGreaterThan(2);
    expect(errors.unexpected).toEqual([]);
    expect(afterSeek.at(-1)!.frame, 'the gap clock must advance beyond the explicit seek target').toBeGreaterThan(30);
    expect(afterSeek.at(-1)!.frame).toBeGreaterThan(afterSeek[0].frame!);
    expect(afterSeek.every((reading) => reading.native === null && reading.reportedStates.includes('Playing'))).toBe(true);
    expect(afterSeek.at(-1)!.frame).toBeLessThan(240);
  } finally {
    try { await preserveEvidence(page, 'same-gap-seek-final', evidence); }
    finally { await deleteSpace(page, spaceId); }
  }
});

test('playing crosses concurrent conflicts and reaches the later ready video @needs-storage @needs-ingest', async ({ page, browser }) => {
  const errors = watchTimelineErrors(page);
  const ownerGate = await installTimelineDeliveryGate(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline conflict playback ${crypto.randomUUID()}`);
  const evidence: Record<string, unknown> = { conflictStart: 240, startPlayback: 239 };
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    const second = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    const third = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    const duration = uploaded.durationFrames;
    evidence.fps = uploaded.fps;
    evidence.durationFrames = duration;
    evidence.thirdReadyStart = duration * 2;
    expect(duration, 'this fixture leaves the fixed conflict interval before the third ready placement').toBeGreaterThan(240);
    await expectTimelineStart(page, third, duration * 2, duration);
    // A direct initial move to 240 would overlap the still-adjacent second clip and be refused.
    // Establish a shared legal gap first; the third ready placement remains at its original start.
    await moveTimelineClip(page, uploaded.clipId, duration * 3, duration);
    await moveTimelineClip(page, second, duration * 4, duration);
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
      const peerErrors = watchTimelineErrors(peer);
      const peerGate = await installTimelineDeliveryGate(peer);
      try {
        await peer.goto(projectUrl);
        await openTimeline(peer, spaceId);
        await expect.poll(async () => (await timelineClipIds(peer)).sort()).toEqual([uploaded.clipId, second, third].sort());
        for (const member of [page, peer]) {
          await expectTimelineStart(member, uploaded.clipId, duration * 3, duration);
          await expectTimelineStart(member, second, duration * 4, duration);
          await expectTimelineStart(member, third, duration * 2, duration);
          await expect(member.getByTestId('connection-banner')).toHaveCount(0);
          await expect(member.getByTestId('workspace-disabled-overlay')).toHaveCount(0);
        }
        ownerGate.holding = true;
        peerGate.holding = true;
        await moveTimelineClip(page, uploaded.clipId, 240, duration);
        await moveTimelineClip(peer, second, 240, duration);
        await expectTimelineStart(page, second, duration * 4, duration);
        await expectTimelineStart(peer, uploaded.clipId, duration * 3, duration);
        await expect.poll(() => ownerGate.pending.length).toBeGreaterThan(0);
        await expect.poll(() => peerGate.pending.length).toBeGreaterThan(0);
        evidence.delayedOriginalFrames = { owner: ownerGate.pending.length, peer: peerGate.pending.length };
        flushTimelineDelivery(ownerGate);
        flushTimelineDelivery(peerGate);
        for (const member of [page, peer]) {
          const outlet = visibleSpace(member);
          await expect(outlet.locator('[data-testid^="timeline-conflict-"]')).toHaveCount(2);
          await expect(outlet.getByTestId(`timeline-conflict-${uploaded.clipId}`)).toContainText(`Start 240 · Duration ${duration} frames`);
          await expect(outlet.getByTestId(`timeline-conflict-${second}`)).toContainText(`Start 240 · Duration ${duration} frames`);
          await expectTimelineStart(member, third, duration * 2, duration);
          await expect(member.getByTestId('connection-banner')).toHaveCount(0);
          await expect(member.getByTestId('workspace-disabled-overlay')).toHaveCount(0);
        }
        const outlet = visibleSpace(page);
        await seekWithKeys(page, 239);
        await expect(outlet.getByRole('slider', { name: 'Preview frame', exact: true })).toHaveAttribute('aria-valuenow', '239');
        await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
        await outlet.getByTestId('timeline-play').click();
        await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();
        const crossing = await observePlayback(page, 350);
        evidence.crossing = crossing;
        evidence.ownerErrors = errors.unexpected;
        evidence.peerErrors = peerErrors.unexpected;
        expect(errors.unexpected).toEqual([]);
        expect(peerErrors.unexpected).toEqual([]);
        expect(crossing.length).toBeGreaterThan(2);
        expect(crossing.at(-1)!.frame, 'conflict presentation must not permanently stop the sequence at frame 240').toBeGreaterThan(240);
        const video = outlet.getByTestId('timeline-preview').locator('video');
        const readyStart = duration * 2;
        const reachReadyTimeout = Math.ceil((readyStart - 239) * uploaded.fps.den / uploaded.fps.num * 1000) + 20_000;
        // The original play intent advances across the conflicts into the later valid placement.
        await expect(video).toHaveCount(1, { timeout: reachReadyTimeout });
        await expectTimelineVideoReady(page, uploaded.asset.fileUrl);
        await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0.2)).toBe(true);
        const ready = await observePlayback(page, 350, uploaded.asset.fileUrl);
        evidence.laterReady = ready;
        expect(ready[0].frame).toBeGreaterThanOrEqual(readyStart);
        expect(ready.at(-1)!.frame).toBeLessThan(readyStart + duration);
        expect(ready.at(-1)!.frame).toBeGreaterThan(ready[0].frame!);
        expect(ready.every((reading) => reading.native !== null && reading.native.sameExpectedUrl
          && !reading.native.paused && reading.native.errorCode === null && reading.native.readyState >= 3)).toBe(true);
        await expect(outlet.locator('[data-testid^="timeline-conflict-"]')).toHaveCount(2);
        expect(errors.unexpected).toEqual([]);
        expect(peerErrors.unexpected).toEqual([]);
      } finally {
        try {
          await preserveEvidence(peer, 'conflict-peer-final', evidence);
          await preserveEvidence(page, 'conflict-owner-before-peer-close', evidence);
        } finally {
          flushTimelineDelivery(ownerGate);
          flushTimelineDelivery(peerGate);
        }
      }
    });
  } finally {
    try { await preserveEvidence(page, 'conflict-boundary-final', evidence); }
    finally {
      flushTimelineDelivery(ownerGate);
      await deleteSpace(page, spaceId);
    }
  }
});

test('Retry reloads and plays the unchanged media URL after a native HTTP error @needs-storage @needs-ingest', async ({ page }) => {
  let mediaUrl: string | null = null;
  let failing = false;
  let failureWindow = false;
  const observed = { expectedMediaErrors: [] as string[], unexpected: [] as string[], requests: 0, failedRequests: 0, normalRequests: 0 };
  page.on('pageerror', (error) => observed.unexpected.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const expectedFailure = failureWindow && mediaUrl !== null && message.location().url === mediaUrl
      && /^Failed to load resource: the server responded with a status of 503(?: |$)/.test(message.text());
    if (expectedFailure) observed.expectedMediaErrors.push(message.text());
    else observed.unexpected.push(message.text());
  });
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline native retry ${crypto.randomUUID()}`);
  const evidence: Record<string, unknown> = {};
  /** Inject only the exact native media request; authorization and every other request remain real. */
  const mediaFailure = async (route: Route): Promise<void> => {
    observed.requests += 1;
    if (failing) {
      observed.failedRequests += 1;
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Controlled native media failure' });
    } else {
      observed.normalRequests += 1;
      await route.continue();
    }
  };
  /** Match the already-authorized media URL without storing a signed URL in the output evidence. */
  const isActualMedia = (url: URL): boolean => mediaUrl !== null && url.href === mediaUrl;
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    mediaUrl = uploaded.asset.fileUrl;
    evidence.fps = uploaded.fps;
    evidence.assetId = uploaded.asset.assetId;
    await closeTimeline(page, spaceId);
    failing = true;
    failureWindow = true;
    await page.route(isActualMedia, mediaFailure);
    await openTimeline(page, spaceId);
    const outlet = visibleSpace(page);
    const video = outlet.getByTestId('timeline-preview').locator('video');
    await expect(video).toHaveAttribute('src', uploaded.asset.fileUrl);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.error?.code ?? 0), { timeout: 20_000 }).toBeGreaterThan(0);
    const retry = outlet.getByTestId('timeline-preview').getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    expect(observed.failedRequests).toBeGreaterThan(0);
    await expect.poll(() => observed.expectedMediaErrors.length).toBeGreaterThan(0);
    evidence.failedNative = await observePlayback(page, 0, mediaUrl);
    const beforeRetry = observed.requests;
    evidence.requestsBeforeRetry = beforeRetry;
    await preserveEvidence(page, 'native-error-before-retry', { ...evidence, observed });
    failing = false;
    const authorized = page.waitForResponse((response) => response.request().method() === 'GET'
      && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/assets/${uploaded.asset.assetId}`);
    await retry.click();
    const response = await authorized;
    expect(response.status(), 'Retry still resolves the real Project-authorized asset').toBe(200);
    const envelope = await response.json() as { data: { assetId: string; fileUrl: string } };
    expect(envelope.data.assetId).toBe(uploaded.asset.assetId);
    expect(envelope.data.fileUrl).toBe(uploaded.asset.fileUrl);
    evidence.authorizationStillSameAssetAndUrl = true;
    evidence.afterRetry = await observePlayback(page, 350, mediaUrl);
    expect(observed.unexpected).toEqual([]);
    await expect.poll(() => observed.requests, { timeout: 8_000 }).toBeGreaterThan(beforeRetry);
    expect(observed.normalRequests).toBeGreaterThan(0);
    await expectTimelineVideoReady(page, uploaded.asset.fileUrl);
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.error?.code ?? null)).toBeNull();
    failureWindow = false;
    await expect(outlet.getByText('Playing', { exact: true })).toBeVisible();
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0.2)).toBe(true);
    const recovered = await observePlayback(page, 350, mediaUrl);
    evidence.recovered = recovered;
    expect(recovered.length).toBeGreaterThan(2);
    expect(recovered.every((reading) => reading.native !== null && reading.native.sameExpectedUrl
      && !reading.native.paused && reading.native.errorCode === null && reading.native.readyState >= 3)).toBe(true);
    expect(recovered.at(-1)!.frame).toBeGreaterThan(recovered[0].frame!);
    expect(recovered.at(-1)!.native!.time).toBeGreaterThan(recovered[0].native!.time);
    expect(observed.unexpected).toEqual([]);
  } finally {
    try { await preserveEvidence(page, 'native-retry-final', { ...evidence, observed }); }
    finally {
      failing = false;
      try { await page.unroute(isActualMedia, mediaFailure); }
      finally { await deleteSpace(page, spaceId); }
    }
  }
});
