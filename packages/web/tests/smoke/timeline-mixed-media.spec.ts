// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Pictures, sounds and text on the Timeline (inner#1709 design §10 smoke row): each kind added from the Project and
 * from a local file (text from Add text), one preview playing video, picture, text and sound together, an upload
 * landed by the server after its page closed, and all of it back after the Space is closed and reopened.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { TimelineClientLimits } from '@breatic/shared';
import { expect, type Locator, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { wavBytes } from '../helpers/media-bytes';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import {
  openTimeline, selectTimelineClip, timelineClipIds, timelineVideoOf, uploadTimelineVideo, watchTimelineErrors, withTimelinePeer,
} from '../helpers/timeline-media';
import { roomForUploads } from '../helpers/upload-budget';
import { uniquePicture } from '../helpers/upload';

/** How long the server and collab take to turn a placeholder into its clip. */
const LANDED_MS = 120_000;
const PICTURE = resolve(__dirname, '../fixtures/portrait.png');

type MediaKind = 'image' | 'audio';

/** A local file to add, with bytes no earlier run stored. */
interface LocalFile { name: string; mimeType: string; buffer: Buffer }

/**
 * A picture or a sound whose bytes are new to this run.
 * @throws {never} Never.
 */
function localFile(kind: MediaKind): LocalFile {
  const id = crypto.randomUUID();
  return kind === 'image'
    ? { name: `picture-${id}.png`, mimeType: 'image/png', buffer: uniquePicture(readFileSync(PICTURE)) }
    : { name: `sound-${id}.wav`, mimeType: 'audio/wav', buffer: wavBytes() };
}

/**
 * Record, from before the page loads, the gain node each media lane is routed through and every lane that starts
 * playing, keyed by clip id: the sound lanes are not in the document, so the page is the only place to read them.
 * @throws {never} Never.
 */
async function watchSoundLanes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const lanes = { gains: new Map<string, GainNode>(), played: new Set<string>() };
    (window as unknown as { __timelineLanes: typeof lanes }).__timelineLanes = lanes;
    const createSource = AudioContext.prototype.createMediaElementSource;
    AudioContext.prototype.createMediaElementSource = function (this: AudioContext, element: HTMLMediaElement) {
      const source = createSource.call(this, element);
      const connect = source.connect.bind(source) as (destination: AudioNode) => AudioNode;
      source.connect = ((destination: AudioNode) => {
        const clipId = element.getAttribute('data-clip-id');
        if (destination instanceof GainNode && clipId !== null) lanes.gains.set(clipId, destination);
        return connect(destination);
      }) as typeof source.connect;
      return source;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      const clipId = this.getAttribute('data-clip-id');
      if (clipId !== null) lanes.played.add(clipId);
      return play.call(this);
    };
  });
}

/**
 * The value of the gain node a clip's lane is routed through, or null before it has one.
 * @throws {never} Never.
 */
async function gainOf(page: Page, clipId: string): Promise<number | null> {
  return page.evaluate((id) => (window as unknown as { __timelineLanes: { gains: Map<string, GainNode> } }).__timelineLanes.gains.get(id)?.gain.value ?? null, clipId);
}

/**
 * Whether a clip's lane has been told to play.
 * @throws {never} Never.
 */
async function played(page: Page, clipId: string): Promise<boolean> {
  return page.evaluate((id) => (window as unknown as { __timelineLanes: { played: Set<string> } }).__timelineLanes.played.has(id), clipId);
}

/**
 * Open Add media with a kind picked, and optionally a track and a start frame.
 * @returns The dialog.
 * @throws {Error} When the dialog or its controls do not answer.
 */
async function openAddMedia(page: Page, kind: MediaKind, source: 'project' | 'local', place?: { track: string; start: number }): Promise<Locator> {
  await visibleSpace(page).getByTestId('timeline-add-media').click();
  const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
  await dialog.getByTestId(`timeline-material-${source}`).click();
  await dialog.getByTestId(`timeline-material-kind-${kind}`).click();
  await expect(dialog.getByTestId(`timeline-material-kind-${kind}`)).toHaveAttribute('aria-pressed', 'true');
  if (place !== undefined) {
    await dialog.getByTestId('timeline-material-track').click();
    await page.getByRole('option', { name: place.track, exact: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await dialog.getByTestId('timeline-start-frame').fill(String(place.start));
  }
  return dialog;
}

/**
 * Confirm the dialog and return the one clip it added.
 * @throws {Error} When the dialog stays open or not exactly one clip appears.
 */
async function confirmOne(page: Page, dialog: Locator, before: string[]): Promise<string> {
  await dialog.getByTestId('timeline-confirm-material').click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(async () => (await timelineClipIds(page)).filter((id) => !before.includes(id)).length).toBe(1);
  return (await timelineClipIds(page)).find((id) => !before.includes(id))!;
}

/**
 * Add a local picture or sound through Add media and wait until collab turns its placeholder into that kind of clip.
 * @returns The clip id.
 * @throws {Error} When the upload does not land as the kind added.
 */
async function addLocal(page: Page, file: LocalFile, kind: MediaKind, place?: { track: string; start: number }): Promise<string> {
  const before = await timelineClipIds(page);
  const dialog = await openAddMedia(page, kind, 'local', place);
  await roomForUploads(1);
  await dialog.getByTestId('timeline-file-input').setInputFiles(file);
  await expect(dialog.getByText(file.name, { exact: true })).toBeVisible();
  const clipId = await confirmOne(page, dialog, before);
  await expect(visibleSpace(page).getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-kind', kind, { timeout: LANDED_MS });
  return clipId;
}

/**
 * Add a Project picture or sound, found by its file name, through Add media.
 * @returns The clip id.
 * @throws {Error} When the Project list never shows it or no clip of that kind appears.
 */
async function addFromProject(page: Page, name: string, kind: MediaKind): Promise<string> {
  const before = await timelineClipIds(page);
  const dialog = await openAddMedia(page, kind, 'project');
  const choice = dialog.locator('[data-testid^="timeline-project-video-"]', { hasText: name });
  const more = dialog.getByRole('button', { name: 'Load more', exact: true });
  for (;;) {
    await expect(choice.or(more).first()).toBeVisible();
    if (await choice.count() > 0) break;
    await more.click();
  }
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  const clipId = await confirmOne(page, dialog, before);
  await expect(visibleSpace(page).getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('data-kind', kind);
  return clipId;
}

/**
 * Put the playhead on a frame with the preview slider's own keys: PageUp steps ten frames, the arrows one.
 * @throws {Error} When the slider does not reach it.
 */
async function seekTo(page: Page, frame: number): Promise<void> {
  const slider = visibleSpace(page).getByRole('slider', { name: 'Preview frame', exact: true });
  await slider.focus();
  await slider.press('Home');
  for (let step = 0; step < Math.floor(frame / 10); step += 1) await slider.press('PageUp');
  for (let step = 0; step < frame % 10; step += 1) await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow', String(frame));
}

/**
 * Press Add text at the playhead and give the new clip its words through its properties.
 * @returns The clip id.
 * @throws {Error} When no text clip appears or its text field is not ready to type into.
 */
async function addText(page: Page, words: string): Promise<string> {
  const outlet = visibleSpace(page);
  const before = await timelineClipIds(page);
  await outlet.getByTestId('timeline-add-text').click();
  await expect.poll(async () => (await timelineClipIds(page)).filter((id) => !before.includes(id)).length).toBe(1);
  const clipId = (await timelineClipIds(page)).find((id) => !before.includes(id))!;
  const clip = outlet.getByTestId(`timeline-clip-${clipId}`);
  await expect(clip).toHaveAttribute('data-kind', 'text');
  await expect(clip).toHaveAttribute('aria-pressed', 'true');
  await expect(clip).toContainText('Default text');
  // The new clip is selected and its text field already has the keyboard (design §6.3).
  const body = outlet.getByTestId('timeline-clip-text-body');
  await expect(body).toBeFocused();
  await expect(body).toHaveValue('Default text');
  await body.fill(words);
  await body.blur();
  await expect(clip).toContainText(words);
  return clipId;
}

/**
 * A clip's preview layer: a picture's `<img>` or a text's `<div>`.
 * @throws {never} Never.
 */
function layerOf(page: Page, clipId: string): Locator {
  return visibleSpace(page).getByTestId('timeline-preview').locator(`[data-clip-id="${clipId}"]`);
}

test.use({ viewport: { width: 1680, height: 1100 } });

test('a picture and a sound added from local files and from the Project, and text from Add text, come back after the Timeline closes @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline mixed add ${crypto.randomUUID()}`);
  try {
    await openTimeline(page, spaceId);
    const limits = await dataOf<TimelineClientLimits>(await page.request.get(`/api/v1/projects/${smokeProjectId()}/timeline-limits`), 'read the new-picture length');
    const pictureFrames = Math.round(limits.media.imageDurationSeconds * limits.defaults.fps.num / limits.defaults.fps.den);
    const picture = localFile('image');
    const sound = localFile('audio');
    const localPicture = await addLocal(page, picture, 'image');
    const localSound = await addLocal(page, sound, 'audio');
    const projectPicture = await addFromProject(page, picture.name, 'image');
    const projectSound = await addFromProject(page, sound.name, 'audio');
    const words = '你好，Timeline';
    const text = await addText(page, words);

    const outlet = visibleSpace(page);
    const kinds = { [localPicture]: 'image', [localSound]: 'audio', [projectPicture]: 'image', [projectSound]: 'audio', [text]: 'text' };
    /**
     * Each clip shows its kind and name on its track, and a picture lasts the configured length.
     * @throws {Error} When a clip is missing or reads differently.
     */
    const expectClips = async (): Promise<void> => {
      await expect.poll(async () => (await timelineClipIds(page)).sort()).toEqual(Object.keys(kinds).sort());
      for (const [id, kind] of Object.entries(kinds)) await expect(outlet.getByTestId(`timeline-clip-${id}`)).toHaveAttribute('data-kind', kind);
      for (const id of [localPicture, projectPicture]) await expect(outlet.getByTestId(`timeline-clip-${id}`)).toContainText(picture.name);
      for (const id of [localSound, projectSound]) await expect(outlet.getByTestId(`timeline-clip-${id}`)).toContainText(sound.name);
      await expect(outlet.getByTestId(`timeline-clip-${text}`)).toContainText(words);
      await selectTimelineClip(page, localPicture);
      await expect(outlet.getByTestId('timeline-clip-duration')).toHaveValue(String(pictureFrames));
      await selectTimelineClip(page, projectSound);
      await expect(outlet.getByTestId('timeline-clip-gain')).toContainText('100%');
      await selectTimelineClip(page, text);
      await expect(outlet.getByTestId('timeline-clip-text-body')).toHaveValue(words);
    };
    await expectClips();

    await page.getByTestId(`space-tab-${spaceId}`).hover();
    await page.getByTestId(`space-tab-close-${spaceId}`).click();
    await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toHaveCount(0);
    await openTimeline(page, spaceId);
    await expectClips();
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('video, picture, text and sound play on one clock, each layer appears as the playhead reaches it, and the sound\'s gain follows its volume @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await watchSoundLanes(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline mixed preview ${crypto.randomUUID()}`);
  try {
    const video = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(video.asset.fileUrl);
    // Above the video: the picture from frame 12, the text from frame 24 and the sound from frame 36.
    const pictureId = await addLocal(page, localFile('image'), 'image', { track: 'New track', start: 12 });
    await seekTo(page, 24);
    const words = 'Mixed 混合';
    const textId = await addText(page, words);
    const soundId = await addLocal(page, localFile('audio'), 'audio', { track: 'New track', start: 36 });
    const outlet = visibleSpace(page);
    for (const id of [pictureId, textId, soundId]) await expect(outlet.getByTestId(`timeline-clip-${id}`)).not.toHaveAttribute('data-track-id', 'visual-1');

    await seekTo(page, 0);
    await expect(timelineVideoOf(page, video.clipId)).toBeVisible();
    await expect(layerOf(page, pictureId)).toBeHidden();
    await expect(layerOf(page, textId)).toHaveCount(0);
    expect(await played(page, soundId)).toBe(false);

    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Pause');
    // The picture, then the text, then the sound join the playing video as the clock passes their starts.
    await expect(layerOf(page, pictureId)).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => layerOf(page, pictureId).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(layerOf(page, textId)).toHaveText(words, { timeout: 15_000 });
    await expect(layerOf(page, textId)).toBeVisible();
    await expect.poll(() => played(page, soundId), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => timelineVideoOf(page, video.clipId).evaluate((element: HTMLVideoElement) => !element.paused && element.currentTime > 0)).toBe(true);
    // Each lane goes through its own gain node at the clip's volume, 100% by default.
    await expect.poll(() => gainOf(page, video.clipId)).toBe(1);
    await expect.poll(() => gainOf(page, soundId)).toBe(1);
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    // Stacked bottom-up by track: video, picture, text.
    await seekTo(page, 30);
    const order = await Promise.all([timelineVideoOf(page, video.clipId), layerOf(page, pictureId), layerOf(page, textId)]
      .map(async (layer) => Number(await layer.evaluate((element) => getComputedStyle(element).zIndex))));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(3);
    await expect(outlet.getByTestId('timeline-preview-notes')).not.toContainText('fonts failed');

    // The volume slider at its top sets the gain node to 398%; mute sets it to silence.
    await seekTo(page, 40);
    await selectTimelineClip(page, soundId);
    const volume = outlet.getByTestId('timeline-clip-gain').getByRole('slider', { name: 'Volume', exact: true });
    await volume.focus();
    await volume.press('End');
    await expect(outlet.getByTestId('timeline-clip-gain')).toContainText('398%');
    await expect.poll(() => gainOf(page, soundId)).toBeCloseTo(3.98, 5);
    await outlet.getByTestId('timeline-clip-mute').click();
    await expect.poll(() => gainOf(page, soundId)).toBe(0);
    await expect.poll(() => gainOf(page, video.clipId)).toBe(1);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('a picture whose uploader closed the page once it was sent lands as a picture clip for another member @needs-storage @needs-ingest', async ({ page, browser }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `Timeline closed upload ${crypto.randomUUID()}`);
  try {
    await withTimelinePeer(page, browser, projectId, 'editor', async (peer) => {
      await peer.goto(page.url());
      await openTimeline(peer, spaceId);
      const file = localFile('image');
      const dialog = await openAddMedia(peer, 'image', 'local');
      await roomForUploads(1);
      await dialog.getByTestId('timeline-file-input').setInputFiles(file);
      // The page's part ends once the server holds the bytes; the rest is the server's and collab's.
      const sent = peer.waitForResponse((response) => /\/assets\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname)
        && response.request().method() === 'POST', { timeout: 60_000 });
      const clipId = await confirmOne(peer, dialog, []);
      expect((await sent).status()).toBe(202);
      await peer.close();

      const seen = visibleSpace(page).getByTestId(`timeline-clip-${clipId}`);
      await expect(seen).toHaveAttribute('data-kind', 'image', { timeout: LANDED_MS });
      await expect(seen).toContainText(file.name);
      await selectTimelineClip(page, clipId);
      await expect(visibleSpace(page).getByTestId('timeline-clip-upload')).toHaveCount(0);
      await expect.poll(() => layerOf(page, clipId).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
    });
  } finally {
    await deleteSpace(page, spaceId);
  }
});
