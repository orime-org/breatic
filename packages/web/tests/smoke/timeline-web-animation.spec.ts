// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web animation in a Timeline (inner#1711): a real execution, its reuse as independent copies, the preview's seek,
 * play and click behaviour, cancel and Run again, and what a Viewer sees. Each case spends one real model run, so
 * every check that needs a finished result shares the one run its case makes.
 */
import { expect, type Locator, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import {
  addProjectTimelineVideo, expectTimelineStart, moveTimelineClip, openTimeline, selectTimelineClip, timelineClipIds,
  uploadTimelineVideo, watchTimelineErrors, withTimelinePeer,
} from '../helpers/timeline-media';

/** The shortest prompt whose picture visibly changes over time, so two moments of it look different. */
const PROMPT = 'A red circle moves from left to right across a white background.';
/** The dialog's default length, which is also the cheapest one the cases need. */
const SECONDS = 4;
/** One run of the model, from Execute to a finished row; the design's cap is two hours. */
const RUN_MS = 240_000;

/**
 * Read a row's execution id from its test id.
 * @throws {Error} When the row has no test id.
 */
async function executionIdOf(row: Locator): Promise<string> {
  const testId = await row.getAttribute('data-testid');
  if (testId === null) throw new Error('The execution row has no test id');
  return testId.replace('timeline-execution-', '');
}

/**
 * Open the creation dialog, check its defaults, write the prompt and press Execute.
 * @returns The new execution's id, read from the row the list opens on.
 * @throws {Error} When the dialog or the accepted row does not appear as designed.
 */
async function executeWebAnimation(page: Page, addAtPlayhead: boolean): Promise<string> {
  const outlet = visibleSpace(page);
  await outlet.getByTestId('timeline-create-web-animation').click();
  const dialog = page.getByRole('dialog', { name: 'Create web animation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('web-animation-duration')).toHaveValue(String(SECONDS));
  await expect(dialog.getByTestId('web-animation-engine')).toHaveText('DeepSeek');
  await expect(dialog.getByTestId('web-animation-aspect')).toHaveText('16:9');
  const add = dialog.getByTestId('web-animation-add-at-playhead');
  await expect(add).toHaveAttribute('aria-checked', 'true');
  if (!addAtPlayhead) {
    await add.click();
    await expect(add).toHaveAttribute('aria-checked', 'false');
  }
  await dialog.getByTestId('web-animation-prompt').fill(PROMPT);
  await dialog.getByTestId('web-animation-execute').click();
  await expect(dialog).toHaveCount(0);
  // The list opens on In progress with the accepted row expanded.
  const list = outlet.getByTestId('timeline-executions');
  await expect(list.getByRole('tab', { name: /^In progress/ })).toHaveAttribute('aria-selected', 'true');
  const row = list.locator('li[data-status][data-testid^="timeline-execution-"]');
  await expect(row).toHaveCount(1);
  const id = await executionIdOf(row);
  await expect(list.getByTestId(`timeline-execution-detail-${id}`)).toBeVisible();
  await expect(row).toContainText(PROMPT);
  return id;
}

/**
 * Close the execution list so the side panel shows the selected clip's properties again.
 * @throws {Error} When the list stays open.
 */
async function closeExecutions(page: Page): Promise<void> {
  const outlet = visibleSpace(page);
  if (await outlet.getByTestId('timeline-executions').count() === 0) return;
  await outlet.getByTestId('timeline-close-executions').click();
  await expect(outlet.getByTestId('timeline-executions')).toHaveCount(0);
}

/**
 * Open the execution list on its Completed view.
 * @returns The list.
 * @throws {Error} When the list or the view does not open.
 */
async function openCompleted(page: Page): Promise<Locator> {
  const outlet = visibleSpace(page);
  if (await outlet.getByTestId('timeline-executions').count() === 0) await outlet.getByTestId('timeline-open-executions').click();
  const list = outlet.getByTestId('timeline-executions');
  // Radix Tabs switch on mousedown, which a real click sends.
  await list.getByRole('tab', { name: /^Completed/ }).click();
  await expect(list.getByRole('tab', { name: /^Completed/ })).toHaveAttribute('aria-selected', 'true');
  return list;
}

/**
 * The preview's seek slider. With the list open, an expanded result has a slider of the same name in the side
 * panel; the editor column comes first in the document.
 * @throws {never} Never.
 */
function previewSlider(page: Page): Locator {
  return visibleSpace(page).getByRole('slider', { name: 'Preview frame', exact: true }).first();
}

/**
 * Move the preview slider from one frame to another with its own keys, without waiting between presses.
 * @throws {Error} When the slider does not end on the target.
 */
async function stepSlider(slider: Locator, from: number, to: number, settle = true): Promise<void> {
  await slider.focus();
  const distance = Math.abs(to - from);
  const [ten, one] = to > from ? ['PageUp', 'ArrowRight'] : ['PageDown', 'ArrowLeft'];
  // Radix PageUp/PageDown move ten integer-frame steps through the same onValueChange as a pointer seek.
  for (let step = 0; step < Math.floor(distance / 10); step += 1) await slider.press(ten);
  for (let step = 0; step < distance % 10; step += 1) await slider.press(one);
  if (settle) await expect(slider).toHaveAttribute('aria-valuenow', String(to));
}

/**
 * Seek the preview to a frame from the start.
 * @throws {Error} When the slider does not reach it.
 */
async function seekPreview(page: Page, frame: number): Promise<void> {
  const slider = previewSlider(page);
  await slider.focus();
  await slider.press('Home');
  await stepSlider(slider, 0, frame);
}

/**
 * Wait until every web copy in the preview has answered its latest position, so a screenshot shows its picture.
 * @throws {Error} When a copy does not answer.
 */
async function copiesAnswered(preview: Locator): Promise<void> {
  await expect(preview.locator('hyperframes-player')).not.toHaveCount(0);
  await expect(preview.locator('hyperframes-player:not([data-web-state="ready"])')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Screenshot a region once two shots taken apart are identical, so no frame is still being painted.
 * @throws {Error} When the region keeps changing.
 */
async function settledShot(region: Locator): Promise<Buffer> {
  let shot = await region.screenshot();
  await expect(async () => {
    await region.page().waitForTimeout(400);
    const next = await region.screenshot();
    const same = next.equals(shot);
    shot = next;
    expect(same).toBe(true);
  }).toPass({ timeout: 30_000 });
  return shot;
}

/**
 * Parse an `HH:MM:SS:FF` timecode into a frame at a nominal rate.
 * @throws {Error} When the text is not a timecode.
 */
function frameOf(timecode: string, nominal: number): number {
  const parts = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/.exec(timecode.trim());
  if (parts === null) throw new Error(`Not a timecode: ${timecode}`);
  const [, hours, minutes, seconds, frames] = parts.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
}

/**
 * Format a frame as the preview's `HH:MM:SS:FF` timecode at a nominal rate.
 * @throws {never} Never.
 */
function timecodeOf(frame: number, nominal: number): string {
  const seconds = Math.floor(frame / nominal);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frame % nominal].map((part) => String(part).padStart(2, '0')).join(':');
}

test.use({ viewport: { width: 1680, height: 1100 } });

test('one real web animation is created, reused as three copies over a video, seeks, plays across copies and is read by a Viewer @needs-model @needs-ingest @needs-storage', async ({ page, browser }) => {
  // Upload (up to 2 min), one real model run (up to RUN_MS) and the Viewer pass; the project's 180 s is too short.
  test.setTimeout(600_000);
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline web animation ${crypto.randomUUID()}`);
  try {
    const outlet = visibleSpace(page);
    const preview = outlet.getByTestId('timeline-preview');
    const uploaded = await uploadTimelineVideo(page, projectId);
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const nominal = Math.max(1, Math.round(uploaded.fps.num / uploaded.fps.den));
    const copyFrames = SECONDS * nominal;
    const clipOf = (id: string): Locator => outlet.getByTestId(`timeline-clip-${id}`);
    const playerOf = (id: string): Locator => preview.locator(`hyperframes-player[data-clip-id="${id}"]`);

    let executionId = '';
    let first = '';
    await test.step('create: Execute runs under In progress, lands a placeholder and finishes as a ready copy', async () => {
      await expect(previewSlider(page)).toHaveAttribute('aria-valuenow', '0');
      executionId = await executeWebAnimation(page, true);
      const list = outlet.getByTestId('timeline-executions');
      await expect(list.getByTestId(`timeline-execution-${executionId}`)).toBeVisible();
      // The placeholder is placed at the playhead on a new track above the video.
      const placeholder = outlet.locator('[data-testid^="timeline-clip-"][data-kind="web-animation"]');
      await expect(placeholder).toHaveCount(1);
      first = (await placeholder.getAttribute('data-clip-id')) ?? '';
      expect(first).not.toBe('');
      await expect(placeholder).not.toHaveAttribute('data-track-id', 'visual-1');
      await expect(placeholder).toHaveAttribute('data-state', 'pending', { timeout: 30_000 });
      await expect(list.getByRole('tab', { name: /^Completed/ })).toHaveText(/Completed\s*1/, { timeout: RUN_MS });
      await openCompleted(page);
      const row = list.getByTestId(`timeline-execution-${executionId}`);
      await expect(row).toHaveAttribute('data-status', 'succeeded');
      await expect(row).toContainText('Succeeded');
      const detail = list.getByTestId(`timeline-execution-detail-${executionId}`);
      await expect(detail).toBeVisible();
      await expect(detail.locator('ol > li')).toHaveCount(4);
      await expect(detail.locator('ol > li svg.lucide-check')).toHaveCount(4);
      await expect(detail).toContainText(/Usage: [\d.,]+ credits/);
      await expect(detail.locator('hyperframes-player')).toHaveCount(1);
      await expect(list.getByTestId(`timeline-execution-add-${executionId}`)).toBeVisible();
      await expect(list.getByTestId(`timeline-execution-cancel-${executionId}`)).toHaveCount(0);
      await expect(clipOf(first)).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
      await closeExecutions(page);
      await expectTimelineStart(page, first, 0, copyFrames);
    });

    // Second copy starts where the first ends; the third starts two seconds in and overlaps both.
    const second = 4 * nominal;
    const third = 2 * nominal;
    const copies: string[] = [];
    await test.step('reuse: the same result is added twice more as independent copies on the first free track above the video', async () => {
      for (const at of [second, third]) {
        await seekPreview(page, at);
        const list = await openCompleted(page);
        const before = await timelineClipIds(page);
        await list.getByTestId(`timeline-execution-add-${executionId}`).click();
        await expect.poll(async () => (await timelineClipIds(page)).length).toBe(before.length + 1);
        const added = (await timelineClipIds(page)).filter((id) => !before.includes(id));
        expect(added).toHaveLength(1);
        copies.push(added[0]);
        await closeExecutions(page);
        await expectTimelineStart(page, added[0], at, copyFrames);
      }
      const all = [first, ...copies];
      expect(new Set(all).size).toBe(3);
      // A copy goes on the first track above the video that is free over its span, else on a new top track (design
      // §3.3): the second fits after the first on its track, the third overlaps the first and gets a track of its own.
      const [firstTrack, secondTrack, thirdTrack] = await Promise.all(all.map((id) => clipOf(id).getAttribute('data-track-id')));
      expect(firstTrack).not.toBe('visual-1');
      expect(secondTrack).toBe(firstTrack);
      expect(thirdTrack).not.toBe(firstTrack);
      expect(thirdTrack).not.toBe('visual-1');
      for (const id of all) {
        await expect(clipOf(id)).toHaveAttribute('data-kind', 'web-animation');
        await expect(clipOf(id)).toHaveAttribute('data-state', 'ready');
      }
      // Where the video, the first copy and the third copy overlap, both copies stack above the video.
      await seekPreview(page, Math.round(2.5 * nominal));
      await expect(preview).toHaveAttribute('data-active-clip-id', uploaded.clipId);
      await expect(preview.locator('video')).toHaveCount(1);
      await expect(playerOf(first)).toHaveCSS('z-index', '2');
      await expect(playerOf(copies[1])).toHaveCSS('z-index', '3');
      await expect(playerOf(copies[0])).toHaveCount(0);
      await expect(preview.locator('[data-testid^="timeline-web-note-"]')).toHaveCount(0);
    });

    await test.step('Viewer: no create button; the list shows the finished row and its result without actions', async () => {
      await withTimelinePeer(page, browser, projectId, 'viewer', async (peer) => {
        const peerErrors = watchTimelineErrors(peer);
        peerErrors.mediaUrls.add(uploaded.asset.fileUrl);
        await peer.goto(projectUrl);
        await openTimeline(peer, spaceId);
        const view = visibleSpace(peer);
        await expect.poll(async () => (await timelineClipIds(peer)).length).toBe(4);
        // Synchronized clips anchor the absence checks below.
        await expect(view.getByTestId('timeline-add-media')).toBeDisabled();
        await expect(view.getByTestId('timeline-create-web-animation')).toHaveCount(0);
        const list = await openCompleted(peer);
        const row = list.getByTestId(`timeline-execution-${executionId}`);
        await expect(row).toHaveAttribute('data-status', 'succeeded');
        await list.getByTestId(`timeline-execution-toggle-${executionId}`).click();
        const detail = list.getByTestId(`timeline-execution-detail-${executionId}`);
        await expect(detail).toBeVisible();
        await expect(detail.locator('ol > li svg.lucide-check')).toHaveCount(4);
        await expect(detail.locator('hyperframes-player')).toHaveCount(1);
        await expect(detail).toContainText(/Usage: [\d.,]+ credits/);
        for (const action of ['cancel', 'add', 'add-placeholder', 'retry']) {
          await expect(list.getByTestId(`timeline-execution-${action}-${executionId}`)).toHaveCount(0);
        }
        expect(peerErrors.unexpected).toEqual([]);
      });
    });

    await test.step('hide: a video on a higher track hides the web copy beneath it at the frames it covers', async () => {
      await selectTimelineClip(page, uploaded.clipId);
      const cover = await addProjectTimelineVideo(page, uploaded.asset.assetId);
      await moveTimelineClip(page, cover, 6 * nominal, uploaded.durationFrames, 'New visual track');
      await seekPreview(page, 5 * nominal);
      await expect(preview).toHaveAttribute('data-active-clip-id', uploaded.clipId);
      await expect(playerOf(copies[0])).toHaveCount(1);
      await seekPreview(page, 7 * nominal);
      await expect(preview).toHaveAttribute('data-active-clip-id', cover);
      await expect(playerOf(copies[0])).toHaveCount(0);
      await expect(preview.locator('hyperframes-player')).toHaveCount(0);
      // Take the covering video away again so the later steps see the three copies over one video.
      await selectTimelineClip(page, cover);
      await outlet.getByTestId('timeline-delete').click();
      await expect.poll(async () => (await timelineClipIds(page)).length).toBe(4);
    });


    // Inside the second copy after the third ends, only the video and the second copy are visible.
    const late = Math.round(7.75 * nominal);
    const early = Math.round(6.25 * nominal);
    let lateShot: Buffer = Buffer.alloc(0);
    await test.step('seek: forward, backward and a fast out-of-order burst end on the latest position', async () => {
      await seekPreview(page, late);
      await expect(playerOf(copies[0])).toHaveCount(1);
      await copiesAnswered(preview);
      lateShot = await settledShot(preview);
      const slider = previewSlider(page);
      await stepSlider(slider, late, early);
      await copiesAnswered(preview);
      const earlyShot = await settledShot(preview);
      expect(earlyShot.equals(lateShot), 'two moments of the animation must look different').toBe(false);
      // Back and forth without waiting for any frame: late, early, late.
      await stepSlider(slider, early, late, false);
      await stepSlider(slider, late, early, false);
      await stepSlider(slider, early, late, false);
      await expect(slider).toHaveAttribute('aria-valuenow', String(late));
      await copiesAnswered(preview);
      await expect.poll(async () => (await preview.screenshot()).equals(lateShot), { timeout: 30_000 }).toBe(true);
      expect((await settledShot(preview)).equals(lateShot)).toBe(true);
      await expect(outlet.getByText('Paused', { exact: true })).toBeVisible();
    });

    await test.step('click: clicking the preview leaves the web picture and the frame alone', async () => {
      await preview.click();
      await page.waitForTimeout(500);
      await expect(previewSlider(page)).toHaveAttribute('aria-valuenow', String(late));
      await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
      expect((await settledShot(preview)).equals(lateShot)).toBe(true);
    });

    await test.step('play: the clock crosses copy starts and ends without stepping back and reaches the sequence end', async () => {
      const end = uploaded.durationFrames;
      const from = 3 * nominal;
      await seekPreview(page, from);
      const timecode = outlet.getByText(/^\d{2}:\d{2}:\d{2}:\d{2} \/ \d{2}:\d{2}:\d{2}:\d{2}$/);
      await expect(timecode).toHaveCount(1);
      const target = (await timecode.innerText()).split(' / ')[1];
      expect(frameOf(target, nominal)).toBe(end);
      await outlet.getByTestId('timeline-play').click();
      // Sample on every animation frame until the clock shows the last frame or a minute passes.
      const samples = await timecode.evaluate(async (element, { last, limitMs }) => {
        const seen: string[] = [];
        const until = performance.now() + limitMs;
        while (performance.now() < until) {
          const text = (element.textContent ?? '').split(' / ')[0];
          if (seen[seen.length - 1] !== text) seen.push(text);
          if (text === last) break;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return seen;
      }, { last: timecodeOf(end - 1, nominal), limitMs: 60_000 });
      const frames = samples.map((text) => frameOf(text, nominal));
      expect(frames[0]).toBeGreaterThanOrEqual(from);
      expect(frames[0]).toBeLessThan(second);
      // While the video buffers the clock rests on the frame the video decoded, which may be a frame behind; it never
      // goes back past a copy's start or end it has crossed, where what is visible changes.
      const edges = [third, second, third + copyFrames, second + copyFrames];
      let reached = frames[0];
      const back = frames.findIndex((frame) => {
        const crossed = Math.max(-1, ...edges.filter((edge) => edge <= reached));
        reached = Math.max(reached, frame);
        return frame < crossed;
      });
      expect(back, `the clock stepped back past a copy edge: ${samples.join(' ')}`).toBe(-1);
      // It went past the end of the first copy, where the second continues the same source, and on to the end.
      expect(frames.some((frame) => frame > second && frame < 2 * second)).toBe(true);
      expect(frames[frames.length - 1]).toBe(end - 1);
      await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    });
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('an execution started without adding a copy is cancelled and offers Run again with its prompt @needs-model @needs-ingest', async ({ page }) => {
  // One real model run is accepted and then drains its in-flight call before it reads Cancelled.
  test.setTimeout(360_000);
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline web cancel ${crypto.randomUUID()}`);
  try {
    const outlet = visibleSpace(page);
    await expect(outlet.getByTestId('timeline-space-empty')).toBeVisible();
    const id = await executeWebAnimation(page, false);
    const list = outlet.getByTestId('timeline-executions');
    await list.getByTestId(`timeline-execution-cancel-${id}`).click();
    // With the switch off nothing is placed on the Timeline.
    await expect(outlet.locator('[data-testid^="timeline-clip-"]')).toHaveCount(0);
    await expect(outlet.getByTestId('timeline-space-empty')).toBeVisible();
    await expect(list.getByRole('tab', { name: /^Completed/ })).toHaveText(/Completed\s*1/, { timeout: RUN_MS });
    await expect(list.getByRole('tab', { name: /^In progress/ })).toHaveText(/In progress\s*0/);
    await openCompleted(page);
    const row = list.getByTestId(`timeline-execution-${id}`);
    await expect(row).toHaveAttribute('data-status', 'cancelled');
    await expect(row).toContainText('Cancelled');
    await expect(list.getByTestId(`timeline-execution-detail-${id}`)).toBeVisible();
    await expect(list.getByTestId(`timeline-execution-add-${id}`)).toHaveCount(0);
    await list.getByTestId(`timeline-execution-retry-${id}`).click();
    const dialog = page.getByRole('dialog', { name: 'Run web animation again', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('web-animation-prompt')).toHaveValue(PROMPT);
    await expect(dialog.getByTestId('web-animation-duration')).toHaveValue(String(SECONDS));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Closing the dialog starts nothing.
    await expect(list.getByRole('tab', { name: /^In progress/ })).toHaveText(/In progress\s*0/);
    await expect(list.locator('li[data-status][data-testid^="timeline-execution-"]')).toHaveCount(1);
    await expect(outlet.locator('[data-testid^="timeline-clip-"]')).toHaveCount(0);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});
