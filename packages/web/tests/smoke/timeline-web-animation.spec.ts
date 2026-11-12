// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Web animation in a Timeline (inner#1711): a real execution, its reuse as independent copies, the preview's seek,
 * play and click behaviour, trim to the source end, a split off the second boundary, a portrait source on a landscape
 * Timeline, the video held while a copy loads, play entering, replaying into and revealing a copy prepared by the
 * preview's instance pool, cancel and Run again, what a Viewer sees, an Editor following another member's run and
 * undoing only their own edit, and a Project duplicated mid-run previewing the result. Each case spends one real
 * model run, so every check that needs a finished result shares the one run its case makes.
 */
import { expect, type Locator, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import {
  addProjectTimelineVideo, expectTimelineStart, moveTimelineClip, openTimeline, selectTimelineClip, timelineClipIds,
  timelineVideoOf, uploadTimelineVideo, watchTimelineErrors, withTimelinePeer,
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
async function executeWebAnimation(page: Page, addAtPlayhead: boolean, aspect: '16:9' | '9:16' = '16:9'): Promise<string> {
  const outlet = visibleSpace(page);
  await outlet.getByTestId('timeline-create-web-animation').click();
  const dialog = page.getByRole('dialog', { name: 'Create web animation', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('web-animation-duration')).toHaveValue(String(SECONDS));
  await expect(dialog.getByTestId('web-animation-engine')).toHaveText('DeepSeek');
  const aspectField = dialog.getByTestId('web-animation-aspect');
  await expect(aspectField).toHaveText('16:9');
  if (aspect !== '16:9') {
    await aspectField.click();
    await page.getByRole('option', { name: aspect, exact: true }).click();
    await expect(aspectField).toHaveText(aspect);
  }
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

/** Screenshot style that leaves the preview's selection box and handles out of the picture. */
const HIDE_HANDLES = '[data-testid="timeline-layer-overlay"] { visibility: hidden !important; }';

/**
 * Screenshot a region once two shots taken apart are identical, so no frame is still being painted.
 * @param style - Style applied only while the shots are taken.
 * @throws {Error} When the region keeps changing.
 */
async function settledShot(region: Locator, style?: string): Promise<Buffer> {
  let shot = await region.screenshot({ style });
  await expect(async () => {
    await region.page().waitForTimeout(400);
    const next = await region.screenshot({ style });
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

/**
 * Drag a handle sideways with the real mouse from its centre.
 * @throws {Error} When the handle has no geometry.
 */
async function dragBy(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox();
  if (box === null) throw new Error('The drag handle has no geometry');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Cross dnd-kit's activation distance before travelling the rest.
  await page.mouse.move(x + Math.sign(dx) * 8, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  // dnd-kit swallows clicks for 50 ms after a drag ends.
  await page.waitForTimeout(100);
}

/** What the preview showed on one animation frame while it played. */
interface PlaySample { frame: number; at: number; paused: boolean; time: number; players: { clipId: string; state: string; opacity: string; marked: boolean }[]; notes: number }

/**
 * Press Play, then sample the clock, one video placement's element and every web copy on each animation frame until
 * the clock reaches a frame, and press Pause from inside the page on that same frame. Each video placement has its
 * own element (#1410), so the sampled one is named by its clip id; while it has no element it reads as paused at -1.
 * @returns The samples, one per animation frame.
 * @throws {Error} When the page cannot be read.
 */
async function playUntil(page: Page, until: number, nominal: number, videoClipId: string): Promise<PlaySample[]> {
  const outlet = visibleSpace(page);
  const timecode = await outlet.getByText(/^\d{2}:\d{2}:\d{2}:\d{2} \/ \d{2}:\d{2}:\d{2}:\d{2}$/).elementHandle();
  await outlet.getByTestId('timeline-play').click();
  const samples = await outlet.getByTestId('timeline-preview').evaluate(async (preview, { clock, until, nominal, limitMs, videoClipId }) => {
    const seen: PlaySample[] = [];
    // Notes sit in the note layer beside the frame, above its operation layer (#1410 design §4.1).
    const notes = preview.parentElement?.querySelector('[data-testid="timeline-preview-notes"]') ?? null;
    const end = performance.now() + limitMs;
    while (performance.now() < end) {
      const parts = /^(\d{2}):(\d{2}):(\d{2}):(\d{2})/.exec(clock?.textContent ?? '');
      const frame = parts === null ? -1 : ((Number(parts[1]) * 60 + Number(parts[2])) * 60 + Number(parts[3])) * nominal + Number(parts[4]);
      const players = [...preview.querySelectorAll<HTMLElement & { iframeElement?: HTMLIFrameElement | null }>('hyperframes-player')].map((player) => ({
        clipId: player.dataset.clipId ?? '',
        state: player.dataset.webState ?? '',
        opacity: player.style.opacity,
        marked: (player.iframeElement as (HTMLIFrameElement & { smokeMark?: boolean }) | null | undefined)?.smokeMark === true,
      }));
      const video = preview.querySelector<HTMLVideoElement>(`video[data-clip-id="${videoClipId}"]`);
      seen.push({ frame, at: performance.now(), paused: video?.paused ?? true, time: video?.currentTime ?? -1, players, notes: notes?.querySelectorAll('[data-testid^="timeline-web-note-"]').length ?? -1 });
      if (frame >= until) {
        document.querySelector<HTMLElement>('[data-testid="timeline-play"]')?.click();
        break;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return seen;
  }, { clock: timecode, until, nominal, limitMs: 60_000, videoClipId });
  await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
  return samples;
}

/** A web copy's page, loaded by its player's cross-origin iframe from the ingest preview route. */
const PAGE_LOAD = /\/web-animation\/[^/]+\/index\.html$/;
/** How long a held-back page load waits: past the seconds play takes to reach the copy, inside the player's 15 s load timeout. */
const SLOW_PAGE_MS = 8_000;

/**
 * Close the Timeline's tab and open it again, which unloads the preview's pool of web pages.
 * @throws {Error} When the tab does not close or the Timeline does not reopen.
 */
async function reopenTimeline(page: Page, spaceId: string): Promise<void> {
  await page.getByTestId(`space-tab-${spaceId}`).hover();
  await page.getByTestId(`space-tab-close-${spaceId}`).click();
  await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toHaveCount(0);
  await openTimeline(page, spaceId);
}

/** A player the preview draws; premounted, idle and not yet answered ones are kept at opacity 0. */
const DRAWN = 'hyperframes-player:not([style*="opacity: 0"])';

/** The longest a played frame may stay on the clock before it counts as frozen; one frame at 24 fps is 42 ms. */
const FROZEN_MS = 300;

/**
 * Assert that the clock ran on from its first step to the last sample: never back more than the one frame the video
 * may rest behind, never resting on a frame longer than {@link FROZEN_MS}.
 * @throws {Error} When the clock stepped back or froze.
 */
function expectSteadyClock(samples: readonly PlaySample[], label: string): void {
  const started = samples.findIndex((sample) => sample.frame !== samples[0].frame);
  expect(started, `${label}: the clock never moved`).toBeGreaterThan(0);
  const run = samples.slice(started);
  const trace = run.map((sample) => `${sample.frame}@${Math.round(sample.at)}`).join(' ');
  let reached = -1;
  const back = run.filter((sample) => {
    const stepped = sample.frame < reached - 1;
    reached = Math.max(reached, sample.frame);
    return stepped;
  });
  expect(back, `${label}: the clock stepped back: ${trace}`).toEqual([]);
  let since = run[0];
  const frozen = run.filter((sample) => {
    if (sample.frame !== since.frame) since = sample;
    return sample.at - since.at > FROZEN_MS;
  });
  expect(frozen, `${label}: the clock froze: ${trace}`).toEqual([]);
}

/**
 * Seek to a frame and add the finished result there as a new copy from the Completed view.
 * @returns The new copy's clip id.
 * @throws {Error} When the copy is not added at that frame.
 */
async function addCopyAt(page: Page, executionId: string, at: number, frames: number): Promise<string> {
  await seekPreview(page, at);
  const list = await openCompleted(page);
  const before = await timelineClipIds(page);
  // A reopened Space shows the row collapsed.
  await expect(list.getByTestId(`timeline-execution-${executionId}`)).toBeVisible();
  if (!await list.getByTestId(`timeline-execution-detail-${executionId}`).isVisible()) await list.getByTestId(`timeline-execution-toggle-${executionId}`).click();
  await list.getByTestId(`timeline-execution-add-${executionId}`).click();
  await expect.poll(async () => (await timelineClipIds(page)).length).toBe(before.length + 1);
  const [added] = (await timelineClipIds(page)).filter((id) => !before.includes(id));
  await closeExecutions(page);
  await expectTimelineStart(page, added, at, frames);
  await expect(visibleSpace(page).getByTestId(`timeline-clip-${added}`)).toHaveAttribute('data-state', 'ready');
  return added;
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
    const drawnOf = (id: string): Locator => preview.locator(`${DRAWN}[data-clip-id="${id}"]`);

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
      await expect(detail).toContainText(/Usage\s*[\d.,]+ credits/);
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
      await expect(timelineVideoOf(page, uploaded.clipId)).toBeVisible();
      await expect(timelineVideoOf(page, uploaded.clipId)).toHaveCSS('z-index', '1');
      await expect(playerOf(first)).toHaveCSS('z-index', '2');
      await expect(playerOf(copies[1])).toHaveCSS('z-index', '3');
      // The second copy starts within the premount lead, so its page is loaded ahead of it, hidden.
      await expect(playerOf(copies[0])).toHaveCSS('opacity', '0');
      // A copy notes that it is loading until its page first answers.
      await copiesAnswered(preview);
      await expect(outlet.getByTestId('timeline-preview-notes').locator('[data-testid^="timeline-web-note-"]')).toHaveCount(0);
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
        await expect(detail).toContainText(/Usage\s*[\d.,]+ credits/);
        for (const action of ['cancel', 'add', 'add-placeholder', 'retry']) {
          await expect(list.getByTestId(`timeline-execution-${action}-${executionId}`)).toHaveCount(0);
        }
        expect(peerErrors.unexpected).toEqual([]);
      });
    });

    await test.step('stack: a video on a higher track is drawn above the web copy beneath it at the frames it covers', async () => {
      await selectTimelineClip(page, uploaded.clipId);
      const cover = await addProjectTimelineVideo(page, uploaded.asset.assetId);
      await moveTimelineClip(page, cover, 6 * nominal, uploaded.durationFrames, 'New visual track');
      await seekPreview(page, 5 * nominal);
      await expect(timelineVideoOf(page, uploaded.clipId)).toBeVisible();
      await expect(timelineVideoOf(page, cover)).not.toBeVisible();
      await expect(drawnOf(copies[0])).toHaveCount(1);
      await seekPreview(page, 7 * nominal);
      // Every visible layer is drawn, stacked by track from the bottom (#1410 design §6.1): the main video, the copy on
      // the first track above it, and the covering video on the new top track over both.
      await expect(timelineVideoOf(page, uploaded.clipId)).toBeVisible();
      await expect(timelineVideoOf(page, cover)).toBeVisible();
      await expect(drawnOf(copies[0])).toHaveCount(1);
      await expect(timelineVideoOf(page, uploaded.clipId)).toHaveCSS('z-index', '1');
      await expect(playerOf(copies[0])).toHaveCSS('z-index', '2');
      await expect(timelineVideoOf(page, cover)).toHaveCSS('z-index', '3');
      // Take the covering video away again so the later steps see the three copies over one video.
      await selectTimelineClip(page, cover);
      await outlet.getByTestId('timeline-delete').click();
      await expect.poll(async () => (await timelineClipIds(page)).length).toBe(4);
    });

    const overlap = copies[1];
    await test.step('trim: dragging a copy\'s right edge past its source end stops it at the source end', async () => {
      // The minimum zoom fits the whole Timeline, so the copy and its handles are on screen.
      const zoom = outlet.getByTestId('timeline-zoom').getByRole('slider');
      await zoom.focus();
      await zoom.press('Home');
      await selectTimelineClip(page, overlap);
      await expect(clipOf(overlap)).toBeInViewport();
      const duration = outlet.getByTestId('timeline-clip-duration');
      await expect(duration).toHaveValue(String(copyFrames));
      const width = (await clipOf(overlap).boundingBox())?.width ?? 0;
      expect(width).toBeGreaterThan(0);
      // Shorten it first, so the clamp below is seen moving the edge rather than a drag that did nothing.
      await dragBy(page, outlet.getByTestId(`timeline-trim-end-${overlap}`), -Math.round(width / 4));
      await expect.poll(async () => Number(await duration.inputValue())).toBeLessThan(copyFrames);
      // Then pull the edge a copy and a half to the right; its track is empty there, so only the source stops it.
      await dragBy(page, outlet.getByTestId(`timeline-trim-end-${overlap}`), Math.round(width * 1.5));
      await expect(duration).toHaveValue(String(copyFrames));
      await expect(outlet.getByTestId('timeline-clip-start')).toHaveValue(String(third));
      await expect(outlet.getByTestId('timeline-clip-in')).toHaveValue('0');
    });

    // Frame 37 at 24 fps is 1.54 s, inside the first copy and before the overlapping one starts at 2 s.
    const cut = 37;
    let right = '';
    await test.step('split: Cmd/Ctrl+B at a frame off the second boundary leaves two ready copies, the second advanced into its source', async () => {
      expect(nominal).toBe(24);
      await selectTimelineClip(page, first);
      await seekPreview(page, cut);
      const before = await timelineClipIds(page);
      await clipOf(first).focus();
      await page.keyboard.press('ControlOrMeta+b');
      await expect.poll(async () => (await timelineClipIds(page)).length).toBe(before.length + 1);
      const added = (await timelineClipIds(page)).filter((id) => !before.includes(id));
      expect(added).toHaveLength(1);
      right = added[0];
      for (const id of [first, right]) {
        await expect(clipOf(id)).toHaveAttribute('data-kind', 'web-animation');
        await expect(clipOf(id)).toHaveAttribute('data-state', 'ready');
      }
      await expect(clipOf(right)).toHaveAttribute('data-track-id', (await clipOf(first).getAttribute('data-track-id')) ?? '');
      await expectTimelineStart(page, first, 0, cut);
      await expect(outlet.getByTestId('timeline-clip-in')).toHaveValue('0');
      await expectTimelineStart(page, right, cut, copyFrames - cut);
      await expect(outlet.getByTestId('timeline-clip-in')).toHaveValue(String(cut));
    });

    await test.step('split: seeking and playing across the cut keep the same page and its picture', async () => {
      const from = cut - 7;
      const to = cut + 7;
      await seekPreview(page, from);
      await expect(drawnOf(first)).toHaveCount(1);
      await copiesAnswered(preview);
      // Mark every loaded page's iframe, the one the pool premounted for the copy after the cut included, and count
      // their loads; a reload or a new player would lose either.
      await preview.locator('hyperframes-player').evaluateAll((players: (HTMLElement & { iframeElement?: HTMLIFrameElement | null })[]) => {
        for (const player of players) {
          const iframe = player.iframeElement as (HTMLIFrameElement & { smokeMark?: boolean; smokeLoads?: number }) | null | undefined;
          if (iframe === null || iframe === undefined) throw new Error('The player has no iframe');
          iframe.smokeMark = true;
          iframe.smokeLoads = 0;
          iframe.addEventListener('load', () => { iframe.smokeLoads = (iframe.smokeLoads ?? 0) + 1; });
        }
      });
      const previewRequests: string[] = [];
      const onRequest = (request: { url: () => string }): void => {
        const path = new URL(request.url()).pathname;
        if (/\/timeline\/sources\/[^/]+\/preview$/.test(path)) previewRequests.push(path);
      };
      page.on('request', onRequest);
      try {
        const slider = previewSlider(page);
        await stepSlider(slider, from, to);
        await expect(drawnOf(right)).toHaveCount(1);
        await expect(drawnOf(first)).toHaveCount(0);
        await copiesAnswered(preview);
        const loadsOf = (): Promise<number> => drawnOf(right).evaluate((player: HTMLElement & { iframeElement?: HTMLIFrameElement | null }) => {
          const iframe = player.iframeElement as (HTMLIFrameElement & { smokeMark?: boolean; smokeLoads?: number }) | null | undefined;
          return iframe?.smokeMark === true ? iframe.smokeLoads ?? 0 : -1;
        });
        expect(await loadsOf(), 'the copy after the cut must show a page loaded before it, without reloading it').toBe(0);
        await expect(outlet.getByTestId('timeline-preview-notes').locator('[data-testid^="timeline-web-note-"]')).toHaveCount(0);

        // Play from before the cut to past it, still before the overlapping copy starts.
        await stepSlider(slider, to, from);
        await copiesAnswered(preview);
        const samples = await playUntil(page, to, nominal, uploaded.clipId);
        expect(samples.some((sample) => sample.frame < cut)).toBe(true);
        expect(samples[samples.length - 1].frame).toBeGreaterThanOrEqual(to);
        // Only the copy's own players count: the overlapping copy two seconds in is premounted, hidden.
        const shown = (sample: PlaySample): PlaySample['players'] => sample.players.filter((player) => (player.clipId === first || player.clipId === right) && player.opacity !== '0');
        const broken = samples.filter((sample) => sample.notes !== 0 || shown(sample).length !== 1 || !shown(sample)[0].marked
          || shown(sample)[0].state === 'loading' || shown(sample)[0].state === 'failed');
        expect(broken, 'one drawn player with a page loaded before the cut must show the copy on every frame').toEqual([]);
        expect(samples.some((sample) => shown(sample)[0]?.clipId === right && sample.frame >= cut)).toBe(true);
        expect(await loadsOf()).toBe(0);
        expect(previewRequests, 'crossing the cut must not fetch the page address again').toEqual([]);
      } finally {
        page.off('request', onRequest);
      }
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

    await test.step('click: clicking the preview selects the topmost layer there and leaves the web picture and the frame alone', async () => {
      // The operation layer above the frame takes the click (#1410 design §4.1); the copy on the highest track at the
      // frame's centre is the second copy, above the video.
      await outlet.getByTestId('timeline-layer-hit').click();
      await expect(clipOf(copies[0])).toHaveAttribute('aria-pressed', 'true');
      await expect(outlet.getByTestId('timeline-layer-proxy')).toBeVisible();
      await page.waitForTimeout(500);
      await expect(previewSlider(page)).toHaveAttribute('aria-valuenow', String(late));
      await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
      // The selection box is drawn over the frame; the picture under it is unchanged.
      expect((await settledShot(preview, HIDE_HANDLES)).equals(lateShot)).toBe(true);
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

    // Ten seconds in, after every copy has ended and while the video still plays.
    const later = 10 * nominal;
    await test.step('hold: a copy that is still loading when play reaches it holds the video on its start until it answers', async () => {
      await seekPreview(page, later);
      const list = await openCompleted(page);
      const before = await timelineClipIds(page);
      await list.getByTestId(`timeline-execution-add-${executionId}`).click();
      await expect.poll(async () => (await timelineClipIds(page)).length).toBe(before.length + 1);
      const [held] = (await timelineClipIds(page)).filter((id) => !before.includes(id));
      await closeExecutions(page);
      await expectTimelineStart(page, held, later, copyFrames);
      await expect(clipOf(held)).toHaveAttribute('data-state', 'ready');
      // The pool loads a copy's page ahead of it and keeps pages it has shown, so a copy still loading when play reaches
      // it needs an empty pool and a page that loads slower than play takes to get there. Every page load is held
      // back for longer than the second before the copy, and the Project is loaded again: that empties the pool and
      // the page-wide address share, and a page the browser kept in memory would bypass the route.
      await page.route(PAGE_LOAD, async (route) => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_PAGE_MS));
        await route.continue();
      });
      const from = later - nominal;
      let samples: PlaySample[];
      try {
        await page.goto(projectUrl);
        await openTimeline(page, spaceId);
        await expect.poll(async () => (await timelineClipIds(page)).length).toBe(before.length + 1);
        await seekPreview(page, from);
        await expect(timelineVideoOf(page, uploaded.clipId)).toBeVisible();
        await expect(playerOf(held)).toHaveAttribute('data-web-state', 'loading');
        samples = await playUntil(page, later + nominal / 2, nominal, uploaded.clipId);
      } finally {
        await page.unroute(PAGE_LOAD);
      }
      const stateOf = (sample: PlaySample): string => sample.players.find((player) => player.clipId === held)?.state ?? 'absent';
      const reached = samples.findIndex((sample) => sample.frame >= later);
      expect(reached).toBeGreaterThan(0);
      const answered = samples.findIndex((sample, index) => index >= reached && stateOf(sample) === 'ready');
      expect(answered, `the copy never answered: ${samples.map((sample) => `${sample.frame}:${stateOf(sample)}`).join(' ')}`).toBeGreaterThan(reached);
      const waiting = samples.slice(reached, answered);
      // Each sample is one animation frame; the copy's page cannot load and answer inside one.
      expect(waiting.length).toBeGreaterThan(0);
      const brief = (list: PlaySample[]): string => list.map((sample) => `${sample.frame}@${sample.time.toFixed(3)}s:${sample.paused ? 'paused' : 'playing'}:${stateOf(sample)}`).join(' ');
      // The clock never passes the copy's start, and the video never plays into it, while the copy loads.
      expect(waiting.filter((sample) => sample.frame > later), `the clock passed the copy start: ${brief(waiting)}`).toEqual([]);
      expect(waiting.filter((sample) => sample.time > later / nominal), `the video played past the copy start: ${brief(waiting)}`).toEqual([]);
      // Once the copy answered, play went on past its start.
      expect(samples[samples.length - 1].frame).toBeGreaterThanOrEqual(later + nominal / 2);
      // The clock stops at the copy's start on one animation frame and the render after it pauses the video, so the video
      // may still be playing for an animation frame or two (it has not reached the start, as asserted above); from about
      // 100 ms on it is paused until the copy answers.
      const settled = waiting.slice(6);
      expect(settled.filter((sample) => !sample.paused).length, `the video kept playing while the copy loaded: ${brief(waiting)}`).toBe(0);
    });
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('play enters a web copy, replays into it and reveals it from under a video without a loading note or a frozen clock @needs-model @needs-ingest @needs-storage', async ({ page }) => {
  // Upload (up to 2 min), one real model run (up to RUN_MS) and three plays; the project's 180 s is too short.
  test.setTimeout(600_000);
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline web pool ${crypto.randomUUID()}`);
  // Every load of a web copy's page, the iframe's cross-origin index.html included.
  const pageLoads: string[] = [];
  const onRequest = (request: { url: () => string }): void => {
    const path = new URL(request.url()).pathname;
    if (PAGE_LOAD.test(path)) pageLoads.push(path);
  };
  page.on('request', onRequest);
  try {
    const outlet = visibleSpace(page);
    const preview = outlet.getByTestId('timeline-preview');
    const uploaded = await uploadTimelineVideo(page, projectId);
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const nominal = Math.max(1, Math.round(uploaded.fps.num / uploaded.fps.den));
    const copyFrames = SECONDS * nominal;
    const playerOf = (clipId: string): Locator => preview.locator(`hyperframes-player[data-clip-id="${clipId}"]`);
    const drawnOf = (clipId: string): Locator => preview.locator(`${DRAWN}[data-clip-id="${clipId}"]`);
    const id = await executeWebAnimation(page, false);
    const list = outlet.getByTestId('timeline-executions');
    await expect(list.getByRole('tab', { name: /^Completed/ })).toHaveText(/Completed\s*1/, { timeout: RUN_MS });
    await openCompleted(page);
    await expect(list.getByTestId(`timeline-execution-${id}`)).toHaveAttribute('data-status', 'succeeded');
    await closeExecutions(page);
    /** Whether a copy was drawn, answered and noted nowhere on every sample at or after the frame it shows from. */
    const shownFrom = (samples: readonly PlaySample[], clipId: string, from: number): string[] => samples.filter((sample) => sample.frame >= from).flatMap((sample) => {
      const player = sample.players.find((candidate) => candidate.clipId === clipId);
      return player !== undefined && player.state === 'ready' && player.opacity !== '0' ? [] : [`${sample.frame}:${player?.state ?? 'absent'}:${player?.opacity ?? ''}`];
    });

    // A copy over the video, six seconds in: playing from three seconds before it is past the premount lead.
    const entry = 6 * nominal;
    const copy = await addCopyAt(page, id, entry, copyFrames);
    await copiesAnswered(preview);
    expect(pageLoads.length, 'the copy\'s page load must be seen as a request').toBeGreaterThan(0);

    await test.step('entry: playing from three seconds before a copy enters it without a note, a pause or a frozen clock', async () => {
      // An empty pool, so the copy's page is loaded only once play comes within the premount lead.
      await reopenTimeline(page, spaceId);
      await seekPreview(page, entry - 3 * nominal);
      await expect(playerOf(copy)).toHaveCount(0);
      const loads = pageLoads.length;
      await expect(timelineVideoOf(page, uploaded.clipId)).toBeVisible();
      // Play on past the copy's end, so the replay below comes back to a copy that has been played through.
      const samples = await playUntil(page, entry + copyFrames + nominal / 2, nominal, uploaded.clipId);
      expect(samples.filter((sample) => sample.notes !== 0).map((sample) => sample.frame), 'no note while playing into the copy').toEqual([]);
      expect(shownFrom(samples.filter((sample) => sample.frame < entry + copyFrames), copy, entry), 'the copy is drawn and ready from its first frame').toEqual([]);
      expectSteadyClock(samples, 'entry');
      expect(pageLoads.length, 'the copy\'s page was loaded during play, ahead of it').toBeGreaterThan(loads);
      const moving = samples.slice(samples.findIndex((sample) => sample.frame !== samples[0].frame), -1);
      expect(moving.filter((sample) => sample.paused).map((sample) => sample.frame), 'the video plays straight into the copy').toEqual([]);
    });

    await test.step('replay: from the start the copy is entered again without a note and without loading its page again', async () => {
      const loads = pageLoads.length;
      await seekPreview(page, 0);
      const samples = await playUntil(page, entry + nominal, nominal, uploaded.clipId);
      expect(samples.filter((sample) => sample.notes !== 0).map((sample) => sample.frame), 'no note while replaying into the copy').toEqual([]);
      expect(shownFrom(samples, copy, entry), 'the copy is drawn and ready from its first frame').toEqual([]);
      expectSteadyClock(samples, 'replay');
      const moving = samples.slice(samples.findIndex((sample) => sample.frame !== samples[0].frame), -1);
      expect(moving.filter((sample) => sample.paused).map((sample) => sample.frame), 'the video plays straight into the copy').toEqual([]);
      expect(pageLoads.slice(loads), 'replaying must not request the copy\'s index.html again').toEqual([]);
    });

    await test.step('reveal: a copy under a higher video is drawn beneath it, and when the video ends shows on top without a note or a wait', async () => {
      // A second copy of the same result goes on the first track above the main one; the playhead cannot pass the
      // sequence end, so it is added inside the video and then moved on its track to after the video ends.
      const lower = 20 * nominal;
      expect(uploaded.durationFrames).toBeLessThan(lower);
      const revealed = await addCopyAt(page, id, entry + copyFrames + nominal, copyFrames);
      await moveTimelineClip(page, revealed, lower, copyFrames);
      await expect(outlet.getByTestId(`timeline-clip-${revealed}`)).toHaveAttribute('data-track-id', (await outlet.getByTestId(`timeline-clip-${copy}`).getAttribute('data-track-id')) ?? '');
      // A video on a new top track that covers the copy's first two seconds and ends inside it.
      const reveal = lower + 2 * nominal;
      await selectTimelineClip(page, uploaded.clipId);
      const cover = await addProjectTimelineVideo(page, uploaded.asset.assetId);
      await moveTimelineClip(page, cover, reveal - uploaded.durationFrames, uploaded.durationFrames, 'New visual track');
      // Under the video the copy is drawn like any layer (#1410 design §6.1), below the video on the higher track.
      await seekPreview(page, lower + nominal);
      await expect(timelineVideoOf(page, cover)).toBeVisible();
      await expect(drawnOf(revealed)).toHaveCount(1);
      await expect(playerOf(revealed)).toHaveCSS('z-index', '1');
      await expect(timelineVideoOf(page, cover)).toHaveCSS('z-index', '2');
      // An empty pool again; a second before the copy starts it is premounted, so it has its player from the start.
      await reopenTimeline(page, spaceId);
      const from = reveal - 3 * nominal;
      await seekPreview(page, from);
      await expect(timelineVideoOf(page, cover)).toBeVisible();
      await expect(playerOf(revealed)).toHaveCount(1);
      const samples = await playUntil(page, reveal + nominal, nominal, cover);
      expect(samples.some((sample) => sample.frame < reveal)).toBe(true);
      expect(samples.filter((sample) => sample.notes !== 0).map((sample) => sample.frame), 'no note at the reveal').toEqual([]);
      const waited = samples.filter((sample) => sample.frame >= reveal - 1 && sample.players.some((player) => player.clipId === revealed && player.state === 'waiting'));
      expect(waited.map((sample) => sample.frame), 'the revealed copy never waits for an answer').toEqual([]);
      expect(shownFrom(samples, revealed, reveal), 'the revealed copy is drawn and ready from the reveal').toEqual([]);
      expectSteadyClock(samples, 'reveal');
      // Past the video's end the copy is the top layer, alone in the frame.
      await expect(timelineVideoOf(page, cover)).not.toBeVisible();
      await expect(drawnOf(revealed)).toHaveCount(1);
      await expect(playerOf(revealed)).toHaveCSS('z-index', '1');
    });
    expect(errors.unexpected).toEqual([]);
  } finally {
    page.off('request', onRequest);
    await deleteSpace(page, spaceId);
  }
});

test('a 9:16 web animation on a 16:9 Timeline is shown whole and centred, not stretched @needs-model @needs-ingest', async ({ page }) => {
  // One real model run (up to RUN_MS) before the copy can be measured.
  test.setTimeout(360_000);
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline web portrait ${crypto.randomUUID()}`);
  try {
    const outlet = visibleSpace(page);
    const preview = outlet.getByTestId('timeline-preview');
    await expect(outlet.getByTestId('timeline-space-empty')).toBeVisible();
    const id = await executeWebAnimation(page, true, '9:16');
    const list = outlet.getByTestId('timeline-executions');
    await expect(list.getByRole('tab', { name: /^Completed/ })).toHaveText(/Completed\s*1/, { timeout: RUN_MS });
    await openCompleted(page);
    await expect(list.getByTestId(`timeline-execution-${id}`)).toHaveAttribute('data-status', 'succeeded');
    const copy = outlet.locator('[data-testid^="timeline-clip-"][data-kind="web-animation"]');
    await expect(copy).toHaveCount(1);
    await expect(copy).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await closeExecutions(page);
    await seekPreview(page, 1);
    await copiesAnswered(preview);
    const player = preview.locator('hyperframes-player');
    await expect(player).toHaveCount(1);
    const { stage, page: shown } = await player.evaluate((element: HTMLElement & { iframeElement?: HTMLIFrameElement | null }) => {
      const box = (rect: DOMRect): { x: number; y: number; width: number; height: number } => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      const iframe = element.iframeElement;
      if (iframe === null || iframe === undefined) throw new Error('The player has no iframe');
      return { stage: box(element.getBoundingClientRect()), page: box(iframe.getBoundingClientRect()) };
    });
    // The player takes the source's base box (#1410 design §2): the 9:16 viewport contained in the 16:9 frame, as tall
    // as the frame and centred in it; the portrait page fills the player.
    const frame = await preview.boundingBox();
    if (frame === null) throw new Error('The preview has no geometry');
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);
    expect(Math.abs(stage.height - frame.height)).toBeLessThanOrEqual(2);
    expect(stage.width / stage.height).toBeCloseTo(9 / 16, 2);
    expect(stage.width).toBeLessThan(frame.width / 2);
    expect(Math.abs((stage.x + stage.width / 2) - (frame.x + frame.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(shown.height - stage.height)).toBeLessThanOrEqual(2);
    expect(shown.width / shown.height).toBeCloseTo(9 / 16, 2);
    expect(Math.abs((shown.x + shown.width / 2) - (stage.x + stage.width / 2))).toBeLessThanOrEqual(2);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('an Editor follows a run another member starts, undoes only their own edit, and a Project duplicated mid-run previews the result @needs-model @needs-ingest', async ({ page, browser }) => {
  // One real model run, a second member and a duplicated Project.
  test.setTimeout(480_000);
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline web peer ${crypto.randomUUID()}`);
  let copyId = '';
  const copyPage = await page.context().newPage();
  const copyErrors = watchTimelineErrors(copyPage);
  try {
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
      const peerErrors = watchTimelineErrors(peer);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      const view = visibleSpace(peer);
      await expect(view.getByTestId('timeline-space-empty')).toBeVisible();

      const id = await executeWebAnimation(page, true);
      const placeholder = visibleSpace(page).locator('[data-testid^="timeline-clip-"][data-kind="web-animation"]');
      await expect(placeholder).toHaveCount(1);
      const clipId = (await placeholder.getAttribute('data-clip-id')) ?? '';
      expect(clipId).not.toBe('');

      // The other member sees the placeholder at once and the row once collab accepts the receipt and signals the
      // Space, after a save of the document.
      const peerClip = view.getByTestId(`timeline-clip-${clipId}`);
      await expect(peerClip).toHaveAttribute('data-state', 'pending', { timeout: 30_000 });
      await view.getByTestId('timeline-open-executions').click();
      const peerList = view.getByTestId('timeline-executions');
      await expect(peerList.getByRole('tab', { name: /^In progress/ })).toHaveText(/In progress\s*1/, { timeout: 60_000 });
      await expect(peerList.getByTestId(`timeline-execution-${id}`)).toBeVisible();

      // Duplicated while the run is going: the copy holds the placeholder and a grant to the execution.
      const duplicated = await page.request.post(`/api/v1/projects/${projectId}/duplicate`);
      expect(duplicated.status(), await duplicated.text()).toBe(201);
      copyId = ((await duplicated.json()) as { data: { id: string } }).data.id;
      await copyPage.goto(`/project/${copyId}`);
      await openTimeline(copyPage, spaceId);
      const copied = visibleSpace(copyPage).getByTestId(`timeline-clip-${clipId}`);
      await expect(copied).toHaveAttribute('data-kind', 'web-animation');
      await expect(copied).toHaveAttribute('data-state', 'pending');

      // The finish reaches the other member through the Space's task signal.
      await expect(peerList.getByRole('tab', { name: /^Completed/ })).toHaveText(/Completed\s*1/, { timeout: RUN_MS });
      await expect(peerClip).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
      await peerList.getByRole('tab', { name: /^Completed/ }).click();
      await expect(peerList.getByTestId(`timeline-execution-${id}`)).toHaveAttribute('data-status', 'succeeded');
      await peerList.getByTestId(`timeline-execution-toggle-${id}`).click();
      await expect(peerList.getByTestId(`timeline-execution-detail-${id}`).locator('hyperframes-player')).toHaveCount(1);
      await expect(peerList.getByTestId(`timeline-execution-add-${id}`)).toBeVisible();
      await closeExecutions(peer);

      // The other member's undo takes back their own duplicate and never the clip the run placed.
      await peerClip.click();
      await expect(peerClip).toHaveAttribute('aria-pressed', 'true');
      await peer.keyboard.press('ControlOrMeta+d');
      await expect.poll(async () => (await timelineClipIds(peer)).length).toBe(2);
      await peer.keyboard.press('ControlOrMeta+z');
      await expect.poll(async () => (await timelineClipIds(peer)).length).toBe(1);
      await peer.keyboard.press('ControlOrMeta+z');
      await expect(peerClip).toHaveAttribute('data-state', 'ready');
      expect(await timelineClipIds(peer)).toEqual([clipId]);
      await expect.poll(async () => timelineClipIds(page)).toEqual([clipId]);
      expect(peerErrors.unexpected).toEqual([]);
    });

    // The duplicate, open since mid-run, turns its placeholder into the result on its refresh interval and draws it.
    const copyView = visibleSpace(copyPage);
    const copied = copyView.locator('[data-testid^="timeline-clip-"][data-kind="web-animation"]');
    await expect(copied).toHaveCount(1);
    await expect(copied).toHaveAttribute('data-state', 'ready', { timeout: 60_000 });
    await seekPreview(copyPage, 1);
    const preview = copyView.getByTestId('timeline-preview');
    await copiesAnswered(preview);
    await expect(preview.locator(`${DRAWN}[data-clip-id="${await copied.getAttribute('data-clip-id')}"]`)).toHaveCount(1);
    expect(copyErrors.unexpected).toEqual([]);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await copyPage.close();
    if (copyId !== '') {
      const archived = await page.request.post(`/api/v1/projects/${copyId}/archive`);
      expect(archived.ok(), `archive the duplicated Project ${copyId}`).toBe(true);
    }
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
    // The step the run stopped at carries its own mark; a cancel is told muted, without the error tone.
    const stopped = list.getByTestId(`timeline-execution-detail-${id}`).locator('ol > li[data-mark="stopped"]');
    await expect(stopped).toHaveCount(1);
    await expect(stopped).not.toHaveClass(/text-status-error-foreground/);
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
