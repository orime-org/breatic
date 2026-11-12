// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Timeline layer transform in the preview (#1410): the selection handles move, scale, stretch and rotate a layer and
 * snap it to the frame centre, each release is one undo step; the properties fields move it by number; a Viewer sees a
 * collaborator's placement but gets no selection box; a web-animation copy drags the same way; and two video tracks,
 * the upper one scaled down, play together. Every value is read back from the Space's live Yjs document.
 */
import { expect, type Locator, type Page } from 'playwright/test';
import type { Doc } from 'yjs';

import { liveModuleUrl, YJS_MANAGER } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import {
  addProjectTimelineVideo, moveTimelineClip, openTimeline, selectTimelineClip, timelineVideoOf, uploadTimelineVideo,
  watchTimelineErrors, withTimelinePeer,
} from '../helpers/timeline-media';

/** A layer's stored `transform` (#1410 design §2). */
interface LayerTransform { x: number; y: number; scaleX: number; scaleY: number; rotation: number }

/** One layer as stored, with the canvas it is placed on. */
interface StoredLayer { transform: LayerTransform; canvas: { width: number; height: number } }

/** A page-pixel rectangle. */
interface Box { x: number; y: number; width: number; height: number }

/** The untouched transform a new placement carries. */
const IDENTITY: LayerTransform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

/**
 * Display pixels a measured box may differ from the computed one: the layer sits inside the frame's 1 px border while
 * the handles sit on the frame's outer box, and the mouse lands on whole pixels.
 */
const PX = 2;

/** One real model run, from Execute to a ready copy; the design's cap is two hours. */
const RUN_MS = 240_000;

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Read one clip's stored transform and the canvas size from the page's own live copy of the Timeline document.
 * @throws {Error} When the document or the clip is not on the page.
 */
async function storedLayer(page: Page, spaceId: string, clipId: string): Promise<StoredLayer> {
  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  return page.evaluate(async ({ managerAt, projectId, spaceId, clipId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as {
      hasDoc: (name: string) => boolean;
      getDoc: (name: string) => Doc;
      docName: { timelineSpace: (projectId: string, spaceId: string) => string };
    };
    const name = manager.docName.timelineSpace(projectId, spaceId);
    if (!manager.hasDoc(name)) throw new Error('The shown Timeline document is not on the page');
    const doc = manager.getDoc(name);
    const settings = doc.getMap('timeline').get('settings') as { width: number; height: number } | undefined;
    if (settings === undefined) throw new Error('The Timeline document has no settings');
    const record = doc.getMap('clips').get(clipId) as { toJSON?: () => unknown } | undefined;
    if (record === undefined) throw new Error(`The Timeline document has no clip ${clipId}`);
    const json = (typeof record.toJSON === 'function' ? record.toJSON() : record) as { transform: LayerTransform };
    return { transform: { ...json.transform }, canvas: { width: settings.width, height: settings.height } };
  }, { managerAt, projectId: smokeProjectId(), spaceId, clipId });
}

/**
 * Read a locator's page box.
 * @throws {Error} When it has no geometry.
 */
async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('The element has no geometry');
  return box;
}

/**
 * The centre of a box.
 * @throws {never} Never.
 */
function centreOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Display pixels per canvas pixel, measured the way the preview measures it: the frame's page width over the canvas width.
 * @throws {Error} When the frame has no geometry.
 */
async function displayFactor(page: Page, canvasWidth: number): Promise<number> {
  return (await boxOf(visibleSpace(page).getByTestId('timeline-preview'))).width / canvasWidth;
}

/**
 * Assert a number lies within a stated distance of the expected one.
 * @throws {Error} When it does not.
 */
function expectNear(actual: number, expected: number, tolerance: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} is not within ${tolerance} of ${expected}`).toBeLessThanOrEqual(tolerance);
}

/**
 * Press at a point, travel by an offset in steps with the real mouse, run a check while still held, and release.
 * @throws {Error} When the check fails.
 */
async function dragFrom(page: Page, from: { x: number; y: number }, dx: number, dy: number, whileHeld?: () => Promise<void>): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
  if (whileHeld !== undefined) await whileHeld();
  await page.mouse.up();
}

/**
 * Wait until the stored transform changes from the given one, and return it.
 * @throws {Error} When it never changes.
 */
async function changedFrom(page: Page, spaceId: string, clipId: string, before: LayerTransform): Promise<LayerTransform> {
  await expect.poll(async () => (await storedLayer(page, spaceId, clipId)).transform).not.toEqual(before);
  return (await storedLayer(page, spaceId, clipId)).transform;
}

/**
 * Turn the toolbar's snap switch (shared by tracks and the preview) on or off.
 * @returns Whether it was on before, for the case to put back: the switch is saved on the account.
 * @throws {Error} When the switch does not take the state.
 */
async function setSnap(page: Page, on: boolean): Promise<boolean> {
  const toggle = visibleSpace(page).getByTestId('timeline-toggle-snap');
  const before = (await toggle.getAttribute('aria-pressed')) === 'true';
  if (before !== on) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
  return before;
}

/**
 * The selected layer's handles: the transparent proxy, a direction handle and the rotation handle.
 * @throws {never} Never.
 */
function handlesOf(page: Page): { proxy: Locator; direction: (dir: string) => Locator; rotation: Locator; guides: Locator } {
  const overlay = visibleSpace(page).getByTestId('timeline-layer-overlay');
  return {
    proxy: overlay.getByTestId('timeline-layer-proxy'),
    direction: (dir) => overlay.locator(`.moveable-control[data-direction="${dir}"]`),
    rotation: overlay.locator('.moveable-rotation-control'),
    guides: overlay.locator('.moveable-guideline'),
  };
}

/**
 * Select the layer under the frame's centre by clicking the preview, and wait for its lazily loaded handles.
 * @throws {Error} When the click does not select that clip or the handles never appear.
 */
async function pickAtCentre(page: Page, clipId: string): Promise<void> {
  const outlet = visibleSpace(page);
  // A layer that is already selected has its proxy over the hit layer, so the click goes to the point, not an element.
  const centre = centreOf(await boxOf(outlet.getByTestId('timeline-layer-hit')));
  await page.mouse.click(centre.x, centre.y);
  await expect(outlet.getByTestId(`timeline-clip-${clipId}`)).toHaveAttribute('aria-pressed', 'true');
  const handles = handlesOf(page);
  await expect(handles.proxy).toBeVisible();
  await expect(handles.direction('se')).toBeVisible();
  await expect(handles.rotation).toBeVisible();
}

/**
 * Assert that the drawn layer element sits where its handles' proxy does, so the picture itself moved.
 * @throws {Error} When the layer and the proxy part.
 */
async function expectLayerUnderProxy(page: Page, layer: Locator): Promise<void> {
  const proxy = handlesOf(page).proxy;
  await expect.poll(async () => {
    const [drawn, held] = [await boxOf(layer), await boxOf(proxy)];
    return Math.max(Math.abs(drawn.x - held.x), Math.abs(drawn.y - held.y), Math.abs(drawn.width - held.width), Math.abs(drawn.height - held.height));
  }, { message: 'the drawn layer follows its handles' }).toBeLessThanOrEqual(PX);
}

test('an Editor scales, stretches, moves and rotates a video layer with the preview handles, undoes and redoes a drag, and snaps it to the frame centre @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline layer handles ${crypto.randomUUID()}`);
  let snapWas: boolean | null = null;
  try {
    const uploaded = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const outlet = visibleSpace(page);
    const video = timelineVideoOf(page, uploaded.clipId);
    const start = await storedLayer(page, spaceId, uploaded.clipId);
    expect(start.transform).toEqual(IDENTITY);
    const factor = await displayFactor(page, start.canvas.width);
    expect(factor).toBeGreaterThan(0);
    // Measured deltas below are exact only without snapping; the snap step turns it on itself.
    snapWas = await setSnap(page, false);
    await pickAtCentre(page, uploaded.clipId);
    const handles = handlesOf(page);
    await expectLayerUnderProxy(page, video);

    let stored = start.transform;
    await test.step('a corner handle scales both axes by one ratio around the opposite corner', async () => {
      const before = await boxOf(handles.proxy);
      const corner = centreOf(await boxOf(handles.direction('se')));
      await dragFrom(page, corner, -before.width / 4, -before.height / 4);
      stored = await changedFrom(page, spaceId, uploaded.clipId, stored);
      expectNear(stored.scaleX, 0.75, 0.01, 'scaleX');
      expect(stored.scaleY, 'a corner keeps the ratio').toBeCloseTo(stored.scaleX, 3);
      expect(stored.rotation).toBe(0);
      // The opposite corner stays put, so the centre moves an eighth of the box up and left.
      expectNear(stored.x, -before.width / 8 / factor, PX / factor, 'x');
      expectNear(stored.y, -before.height / 8 / factor, PX / factor, 'y');
      const after = await boxOf(handles.proxy);
      expectNear(after.x, before.x, PX, 'left edge');
      expectNear(after.y, before.y, PX, 'top edge');
      expectNear(after.width, before.width * 0.75, PX, 'width');
      expectNear(after.height, before.height * 0.75, PX, 'height');
      await expectLayerUnderProxy(page, video);
    });

    await test.step('an edge handle stretches only its own axis', async () => {
      const before = await boxOf(handles.proxy);
      const previous = stored;
      const edge = centreOf(await boxOf(handles.direction('e')));
      await dragFrom(page, edge, before.width / 5, 0);
      stored = await changedFrom(page, spaceId, uploaded.clipId, stored);
      expectNear(stored.scaleX, previous.scaleX * 1.2, 0.01, 'scaleX');
      expect(stored.scaleY, 'an edge leaves the other axis').toBe(previous.scaleY);
      expect(stored.rotation).toBe(0);
      expectNear(stored.x, previous.x + before.width / 10 / factor, PX / factor, 'x');
      expect(stored.y).toBe(previous.y);
      const after = await boxOf(handles.proxy);
      expectNear(after.x, before.x, PX, 'left edge');
      expectNear(after.y, before.y, PX, 'top edge');
      expectNear(after.height, before.height, PX, 'height');
      expectNear(after.width, before.width * 1.2, PX, 'width');
      await expectLayerUnderProxy(page, video);
    });

    let moved = stored;
    await test.step('dragging inside the box moves it, and one undo and one redo take back and restore that drag', async () => {
      const before = await boxOf(handles.proxy);
      const previous = stored;
      // Towards the frame centre, short of it, so the box stays clear of the frame's edges for the rotation handle.
      const frame = centreOf(await boxOf(outlet.getByTestId('timeline-preview')));
      const dx = Math.round(frame.x - centreOf(before).x) + 30;
      const dy = Math.round(frame.y - centreOf(before).y) + 20;
      await dragFrom(page, centreOf(before), dx, dy);
      stored = await changedFrom(page, spaceId, uploaded.clipId, stored);
      expectNear(stored.x, previous.x + dx / factor, PX / factor, 'x');
      expectNear(stored.y, previous.y + dy / factor, PX / factor, 'y');
      expect({ scaleX: stored.scaleX, scaleY: stored.scaleY, rotation: stored.rotation }).toEqual({ scaleX: previous.scaleX, scaleY: previous.scaleY, rotation: 0 });
      const after = await boxOf(handles.proxy);
      expectNear(after.x - before.x, dx, PX, 'box moved right');
      expectNear(after.y - before.y, dy, PX, 'box moved down');
      await expectLayerUnderProxy(page, video);
      moved = stored;

      await outlet.getByTestId('timeline-undo').click();
      await expect.poll(async () => (await storedLayer(page, spaceId, uploaded.clipId)).transform).toEqual(previous);
      await expectLayerUnderProxy(page, video);
      await outlet.getByTestId('timeline-redo').click();
      await expect.poll(async () => (await storedLayer(page, spaceId, uploaded.clipId)).transform).toEqual(moved);
      await expectLayerUnderProxy(page, video);
    });

    await test.step('the rotation handle turns the box clockwise about its centre', async () => {
      const before = await boxOf(handles.proxy);
      const centre = centreOf(before);
      const grip = centreOf(await boxOf(handles.rotation));
      expect(grip.y, 'the rotation handle sits above the box').toBeLessThan(before.y);
      const radius = Math.hypot(grip.x - centre.x, grip.y - centre.y);
      // From straight above the centre to straight right of it: a quarter turn clockwise.
      await dragFrom(page, grip, centre.x + radius - grip.x, centre.y - grip.y);
      stored = await changedFrom(page, spaceId, uploaded.clipId, moved);
      expectNear(stored.rotation, 90, 1, 'rotation');
      expect({ ...stored, rotation: 0 }).toEqual({ ...moved, rotation: 0 });
      const after = await boxOf(handles.proxy);
      expectNear(centreOf(after).x, centre.x, PX, 'centre x');
      expectNear(centreOf(after).y, centre.y, PX, 'centre y');
      // A quarter turn swaps the box's page width and height.
      expectNear(after.width, before.height, PX, 'turned width');
      expectNear(after.height, before.width, PX, 'turned height');
      await expectLayerUnderProxy(page, video);
      await outlet.getByTestId('timeline-undo').click();
      await expect.poll(async () => (await storedLayer(page, spaceId, uploaded.clipId)).transform).toEqual(moved);
    });

    await test.step('with snap on, a drop a few pixels off the frame centre lands on it and shows a guide; with snap off it does not', async () => {
      const frame = centreOf(await boxOf(outlet.getByTestId('timeline-preview')));
      const from = centreOf(await boxOf(handles.proxy));
      // Three and two display pixels off centre: inside the 6 px snap threshold.
      const dx = frame.x + 3 - from.x;
      const dy = frame.y + 2 - from.y;
      await dragFrom(page, from, dx, dy, async () => {
        await expect(handles.guides).toHaveCount(0);
      });
      const loose = await changedFrom(page, spaceId, uploaded.clipId, moved);
      expectNear(loose.x, moved.x + dx / factor, PX / factor, 'unsnapped x');
      expectNear(loose.y, moved.y + dy / factor, PX / factor, 'unsnapped y');
      expect(Math.abs(loose.x), 'unsnapped, the drop stays off centre').toBeGreaterThan(1 / factor);
      await outlet.getByTestId('timeline-undo').click();
      await expect.poll(async () => (await storedLayer(page, spaceId, uploaded.clipId)).transform).toEqual(moved);

      await setSnap(page, true);
      await dragFrom(page, centreOf(await boxOf(handles.proxy)), dx, dy, async () => {
        await expect(handles.guides.first()).toBeVisible();
      });
      const snapped = await changedFrom(page, spaceId, uploaded.clipId, moved);
      // The base box is centred in the canvas, so a centred layer has no offset.
      expectNear(snapped.x, 0, 0.5, 'snapped x');
      expectNear(snapped.y, 0, 0.5, 'snapped y');
      expect({ scaleX: snapped.scaleX, scaleY: snapped.scaleY, rotation: snapped.rotation }).toEqual({ scaleX: moved.scaleX, scaleY: moved.scaleY, rotation: 0 });
      await expectLayerUnderProxy(page, video);
    });
    expect(errors.unexpected).toEqual([]);
  } finally {
    if (snapWas !== null) await setSnap(page, snapWas);
    await deleteSpace(page, spaceId);
  }
});

test('numbers typed into the properties fields move, scale and rotate the layer in the preview @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline layer fields ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const outlet = visibleSpace(page);
    const video = timelineVideoOf(page, uploaded.clipId);
    const { canvas } = await storedLayer(page, spaceId, uploaded.clipId);
    const factor = await displayFactor(page, canvas.width);
    const frame = centreOf(await boxOf(outlet.getByTestId('timeline-preview')));
    const original = await boxOf(video);
    expectNear(centreOf(original).x, frame.x, PX, 'untouched centre x');
    expectNear(centreOf(original).y, frame.y, PX, 'untouched centre y');
    await selectTimelineClip(page, uploaded.clipId);
    /**
     * Type a value into a field and press Enter.
     * @throws {Error} When the field is not editable.
     */
    const type = async (testId: string, value: string): Promise<void> => {
      const field = outlet.getByTestId(testId);
      await field.fill(value);
      await field.press('Enter');
    };
    const read = async (): Promise<LayerTransform> => (await storedLayer(page, spaceId, uploaded.clipId)).transform;

    await type('timeline-clip-x', '100');
    await expect.poll(read).toEqual({ ...IDENTITY, x: 100 });
    await type('timeline-clip-y', '-50');
    await expect.poll(read).toEqual({ ...IDENTITY, x: 100, y: -50 });
    await expect.poll(async () => centreOf(await boxOf(video)).x - frame.x).toBeGreaterThan(100 * factor - PX);
    expectNear(centreOf(await boxOf(video)).x - frame.x, 100 * factor, PX, 'moved right');
    expectNear(centreOf(await boxOf(video)).y - frame.y, -50 * factor, PX, 'moved up');

    // The ratio lock is on by default: one scale field carries the other.
    await expect(outlet.getByTestId('timeline-clip-lock-ratio')).toHaveAttribute('aria-pressed', 'true');
    await type('timeline-clip-scale-x', '50');
    await expect.poll(read).toEqual({ ...IDENTITY, x: 100, y: -50, scaleX: 0.5, scaleY: 0.5 });
    await expect(outlet.getByTestId('timeline-clip-scale-y')).toHaveValue('50');
    await expect.poll(async () => (await boxOf(video)).width).toBeLessThan(original.width * 0.5 + PX);
    expectNear((await boxOf(video)).width, original.width * 0.5, PX, 'half width');
    expectNear((await boxOf(video)).height, original.height * 0.5, PX, 'half height');

    await outlet.getByTestId('timeline-clip-lock-ratio').click();
    await expect(outlet.getByTestId('timeline-clip-lock-ratio')).toHaveAttribute('aria-pressed', 'false');
    await type('timeline-clip-scale-y', '80');
    await expect.poll(read).toEqual({ ...IDENTITY, x: 100, y: -50, scaleX: 0.5, scaleY: 0.8 });
    await type('timeline-clip-rotation', '90');
    await expect.poll(read).toEqual({ x: 100, y: -50, scaleX: 0.5, scaleY: 0.8, rotation: 90 });
    // A quarter turn swaps the page width and height of the half-wide, 80 %-high layer, about the same centre.
    await expect.poll(async () => Math.abs((await boxOf(video)).width - original.height * 0.8)).toBeLessThanOrEqual(PX);
    expectNear((await boxOf(video)).height, original.width * 0.5, PX, 'turned height');
    expectNear(centreOf(await boxOf(video)).x - frame.x, 100 * factor, PX, 'turned centre x');
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('a Viewer sees the layer an Editor dragged at its new place, and clicking the preview gives the Viewer no selection box @needs-storage @needs-ingest', async ({ page, browser }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline layer viewer ${crypto.randomUUID()}`);
  let snapWas: boolean | null = null;
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    await withTimelinePeer(page, browser, projectId, 'viewer', async (peer) => {
      const peerErrors = watchTimelineErrors(peer);
      peerErrors.mediaUrls.add(uploaded.asset.fileUrl);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      await expect.poll(async () => (await storedLayer(peer, spaceId, uploaded.clipId)).transform).toEqual(IDENTITY);

      // The Editor drags the layer while the Viewer has the Timeline open.
      snapWas = await setSnap(page, false);
      await pickAtCentre(page, uploaded.clipId);
      await dragFrom(page, centreOf(await boxOf(handlesOf(page).proxy)), 60, 40);
      const moved = await changedFrom(page, spaceId, uploaded.clipId, IDENTITY);
      const { canvas } = await storedLayer(page, spaceId, uploaded.clipId);
      const factor = await displayFactor(page, canvas.width);
      expectNear(moved.x, 60 / factor, PX / factor, 'Editor x');
      expectNear(moved.y, 40 / factor, PX / factor, 'Editor y');

      // The Viewer's document and picture follow.
      await expect.poll(async () => (await storedLayer(peer, spaceId, uploaded.clipId)).transform).toEqual(moved);
      const view = visibleSpace(peer);
      const peerFactor = await displayFactor(peer, canvas.width);
      const peerVideo = timelineVideoOf(peer, uploaded.clipId);
      await expect(peerVideo).toBeVisible();
      const frame = centreOf(await boxOf(view.getByTestId('timeline-preview')));
      await expect.poll(async () => Math.abs(centreOf(await boxOf(peerVideo)).x - frame.x - moved.x * peerFactor)).toBeLessThanOrEqual(PX);
      expectNear(centreOf(await boxOf(peerVideo)).y - frame.y, moved.y * peerFactor, PX, 'Viewer centre y');

      // A Viewer's preview has no operation layer: a click selects nothing and draws no box.
      await expect(view.getByTestId('timeline-layer-overlay')).toHaveCount(0);
      await view.getByTestId('timeline-preview').click();
      await expect(view.getByTestId(`timeline-clip-${uploaded.clipId}`)).toHaveAttribute('aria-pressed', 'false');
      await expect(view.getByTestId('timeline-layer-proxy')).toHaveCount(0);
      await expect(view.locator('.moveable-control')).toHaveCount(0);
      // Selected from the track, the fields read as text and still no handles appear.
      await selectTimelineClip(peer, uploaded.clipId);
      await expect(view.getByTestId('timeline-clip-x')).toHaveText(String(Math.round(moved.x)));
      await expect(view.locator('input[data-testid="timeline-clip-x"]')).toHaveCount(0);
      await expect(view.getByTestId('timeline-clip-lock-ratio')).toBeDisabled();
      await expect(view.getByTestId('timeline-layer-proxy')).toHaveCount(0);
      expect(peerErrors.unexpected).toEqual([]);
    });
    expect(errors.unexpected).toEqual([]);
  } finally {
    if (snapWas !== null) await setSnap(page, snapWas);
    await deleteSpace(page, spaceId);
  }
});

test('two video tracks, the upper one scaled down, play together within two frames of each other @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline layer playback ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const upper = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    await moveTimelineClip(page, upper, 0, uploaded.durationFrames, 'New visual track');
    const outlet = visibleSpace(page);
    const lower = timelineVideoOf(page, uploaded.clipId);
    const above = timelineVideoOf(page, upper);
    await selectTimelineClip(page, upper);
    const scale = outlet.getByTestId('timeline-clip-scale-x');
    await scale.fill('50');
    await scale.press('Enter');
    await expect.poll(async () => (await storedLayer(page, spaceId, upper)).transform).toEqual({ ...IDENTITY, scaleX: 0.5, scaleY: 0.5 });
    // Both are in the frame: the upper one half-size on top, the lower one around it.
    await expect(lower).toBeVisible();
    await expect(above).toBeVisible();
    await expect(lower).toHaveCSS('z-index', '1');
    await expect(above).toHaveCSS('z-index', '2');
    await expect.poll(async () => Math.abs((await boxOf(above)).width - (await boxOf(lower)).width / 2)).toBeLessThanOrEqual(PX);

    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Pause');
    await expect.poll(() => outlet.getByTestId('timeline-preview').evaluate((preview, ids) => ids.every((id) => {
      const video = preview.querySelector<HTMLVideoElement>(`video[data-clip-id="${id}"]`);
      return video !== null && !video.paused && video.currentTime > 0.2;
    }), [uploaded.clipId, upper]), { timeout: 20_000 }).toBe(true);
    // One second of animation frames, both elements read in the same task on each.
    const samples = await outlet.getByTestId('timeline-preview').evaluate(async (preview, ids) => {
      const seen: { at: number; lower: number; upper: number; paused: boolean }[] = [];
      const until = performance.now() + 1_000;
      while (performance.now() < until) {
        const [a, b] = ids.map((id) => preview.querySelector<HTMLVideoElement>(`video[data-clip-id="${id}"]`));
        seen.push({ at: performance.now(), lower: a?.currentTime ?? -1, upper: b?.currentTime ?? -1, paused: a === null || b === null || a.paused || b.paused });
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return seen;
    }, [uploaded.clipId, upper]);
    await outlet.getByTestId('timeline-play').click();
    await expect(outlet.getByTestId('timeline-play')).toHaveText('Play');
    const twoFrames = 2 * uploaded.fps.den / uploaded.fps.num;
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.filter((sample) => sample.paused), 'both videos play throughout').toEqual([]);
    expect(samples.filter((sample) => Math.abs(sample.lower - sample.upper) > twoFrames), `the two videos stay within ${twoFrames} s`).toEqual([]);
    expect(samples.at(-1)!.lower).toBeGreaterThan(samples[0].lower + 0.5);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('a web-animation copy is selected and dragged in the preview like a video layer @needs-model @needs-ingest', async ({ page }) => {
  // One real model run (up to RUN_MS) before the copy can be dragged.
  test.setTimeout(360_000);
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline layer web copy ${crypto.randomUUID()}`);
  let snapWas: boolean | null = null;
  try {
    const outlet = visibleSpace(page);
    await expect(outlet.getByTestId('timeline-space-empty')).toBeVisible();
    await outlet.getByTestId('timeline-create-web-animation').click();
    const dialog = page.getByRole('dialog', { name: 'Create web animation', exact: true });
    await expect(dialog.getByTestId('web-animation-add-at-playhead')).toHaveAttribute('aria-checked', 'true');
    await dialog.getByTestId('web-animation-prompt').fill('A red circle moves from left to right across a white background.');
    await dialog.getByTestId('web-animation-execute').click();
    await expect(dialog).toHaveCount(0);
    const placed = outlet.locator('[data-testid^="timeline-clip-"][data-kind="web-animation"]');
    await expect(placed).toHaveCount(1);
    await expect(placed).toHaveAttribute('data-state', 'ready', { timeout: RUN_MS + 60_000 });
    const clipId = (await placed.getAttribute('data-clip-id')) ?? '';
    expect(clipId).not.toBe('');
    // The execution list opened with the run; close it so the side panel is back.
    await outlet.getByTestId('timeline-close-executions').click();
    const player = outlet.getByTestId('timeline-preview').locator(`hyperframes-player[data-clip-id="${clipId}"]`);
    await expect(player).toHaveAttribute('data-web-state', 'ready', { timeout: 30_000 });

    const { transform, canvas } = await storedLayer(page, spaceId, clipId);
    expect(transform).toEqual(IDENTITY);
    const factor = await displayFactor(page, canvas.width);
    snapWas = await setSnap(page, false);
    await pickAtCentre(page, clipId);
    await expectLayerUnderProxy(page, player);
    const before = await boxOf(player);
    await dragFrom(page, centreOf(await boxOf(handlesOf(page).proxy)), 50, 30);
    const moved = await changedFrom(page, spaceId, clipId, IDENTITY);
    expectNear(moved.x, 50 / factor, PX / factor, 'x');
    expectNear(moved.y, 30 / factor, PX / factor, 'y');
    expect({ scaleX: moved.scaleX, scaleY: moved.scaleY, rotation: moved.rotation }).toEqual({ scaleX: 1, scaleY: 1, rotation: 0 });
    await expectLayerUnderProxy(page, player);
    const after = await boxOf(player);
    expectNear(after.x - before.x, 50, PX, 'copy moved right');
    expectNear(after.y - before.y, 30, PX, 'copy moved down');
    expect(errors.unexpected).toEqual([]);
  } finally {
    if (snapWas !== null) await setSnap(page, snapWas);
    await deleteSpace(page, spaceId);
  }
});
