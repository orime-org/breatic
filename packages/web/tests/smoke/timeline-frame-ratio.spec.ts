// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Timeline frame ratio (#1502): an Editor picks 9:16 from the play bar, the preview frame takes that ratio inside the
 * preview area and a layer placed near the frame's corner stays in the frame at the same relative place; undo returns
 * to 16:9; a Viewer watching follows both and finds the control disabled.
 */
import { expect, type Locator, type Page } from 'playwright/test';
import type { Doc } from 'yjs';

import { liveModuleUrl, YJS_MANAGER } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { openTimeline, selectTimelineClip, timelineVideoOf, uploadTimelineVideo, watchTimelineErrors, withTimelinePeer } from '../helpers/timeline-media';

/** A page-pixel rectangle. */
interface Box { x: number; y: number; width: number; height: number }

/** The two presets the case moves between, as the control labels them and as the document stores them. */
const LANDSCAPE = { label: '16:9 · 1920×1080', width: 1920, height: 1080 };
const PORTRAIT = { label: '9:16 · 1080×1920', width: 1080, height: 1920 };

/** Where the layer is put: a third of its size, its centre toward the top-right corner (#1502 design §4 example). */
const PLACED = { frameX: 0.35, frameY: -0.35, scalePercent: '30' };

/** Display pixels a measured position may differ from the computed one (whole-pixel layout, the frame's 1 px border). */
const PX = 2;

test.use({ viewport: { width: 1680, height: 1100 } });

/**
 * Read the frame size stored in the page's own live copy of the Timeline document.
 * @throws {Error} When the document is not on the page or has no settings.
 */
async function storedFrame(page: Page, spaceId: string): Promise<{ width: number; height: number }> {
  const managerAt = await liveModuleUrl(page, YJS_MANAGER);
  return page.evaluate(async ({ managerAt, projectId, spaceId }) => {
    const manager = await import(/* @vite-ignore */ managerAt) as {
      hasDoc: (name: string) => boolean;
      getDoc: (name: string) => Doc;
      docName: { timelineSpace: (projectId: string, spaceId: string) => string };
    };
    const name = manager.docName.timelineSpace(projectId, spaceId);
    if (!manager.hasDoc(name)) throw new Error('The shown Timeline document is not on the page');
    const settings = manager.getDoc(name).getMap('timeline').get('settings') as { width: number; height: number } | undefined;
    if (settings === undefined) throw new Error('The Timeline document has no settings');
    return { width: settings.width, height: settings.height };
  }, { managerAt, projectId: smokeProjectId(), spaceId });
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
 * The frame's drawn area inside its 1 px border, in page pixels.
 * @throws {Error} When the frame has no geometry.
 */
async function frameInner(page: Page): Promise<Box> {
  return visibleSpace(page).getByTestId('timeline-preview').evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    return { x: rect.left + frame.clientLeft, y: rect.top + frame.clientTop, width: frame.clientWidth, height: frame.clientHeight };
  });
}

/**
 * Assert the shown Timeline is at a preset: the control's label, the stored size, a frame of that ratio drawn whole
 * inside the preview area, and the layer's centre in the frame at its stored relative place.
 * @throws {Error} When any of them differs.
 */
async function expectAt(page: Page, spaceId: string, clipId: string, preset: typeof LANDSCAPE): Promise<void> {
  const outlet = visibleSpace(page);
  await expect(outlet.getByTestId('timeline-frame-ratio')).toHaveText(preset.label);
  await expect.poll(() => storedFrame(page, spaceId)).toEqual({ width: preset.width, height: preset.height });
  await expect.poll(async () => {
    const inner = await frameInner(page);
    return Math.abs(inner.width / inner.height - preset.width / preset.height);
  }, { message: `the frame is drawn at ${preset.label}` }).toBeLessThan(0.01);
  const [frame, area] = [await boxOf(outlet.getByTestId('timeline-preview')), await boxOf(outlet.getByTestId('timeline-preview-area'))];
  expect(frame.x, 'the frame fits the preview area').toBeGreaterThanOrEqual(area.x - 1);
  expect(frame.y).toBeGreaterThanOrEqual(area.y - 1);
  expect(frame.x + frame.width).toBeLessThanOrEqual(area.x + area.width + 1);
  expect(frame.y + frame.height).toBeLessThanOrEqual(area.y + area.height + 1);

  const inner = await frameInner(page);
  const video = timelineVideoOf(page, clipId);
  await expect(video).toBeVisible();
  // The layer is unrotated, so the centre of its page box is its centre.
  await expect.poll(async () => {
    const layer = await boxOf(video);
    const centre = { x: layer.x + layer.width / 2, y: layer.y + layer.height / 2 };
    return Math.max(
      Math.abs(centre.x - (inner.x + inner.width / 2) - PLACED.frameX * inner.width),
      Math.abs(centre.y - (inner.y + inner.height / 2) - PLACED.frameY * inner.height),
    );
  }, { message: 'the layer keeps its place relative to the frame' }).toBeLessThanOrEqual(PX);
  const layer = await boxOf(video);
  const centre = { x: layer.x + layer.width / 2, y: layer.y + layer.height / 2 };
  expect(centre.x, 'the layer centre is inside the frame').toBeGreaterThan(inner.x);
  expect(centre.x).toBeLessThan(inner.x + inner.width);
  expect(centre.y).toBeGreaterThan(inner.y);
  expect(centre.y).toBeLessThan(inner.y + inner.height);
}

test('an Editor picks 9:16 from the play bar, the corner layer stays in the frame, undo returns to 16:9, and a Viewer follows with the control disabled @needs-storage @needs-ingest', async ({ page, browser }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const projectUrl = page.url();
  const spaceId = await createSpace(page, 'timeline', `Timeline frame ratio ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const outlet = visibleSpace(page);
    await expect(outlet.getByTestId('timeline-frame-ratio')).toHaveText(LANDSCAPE.label);
    await expect(outlet.getByTestId('timeline-frame-ratio')).toBeEnabled();

    // Shrink the layer and put it near the top-right corner through the fields, which take 16:9 canvas pixels.
    await selectTimelineClip(page, uploaded.clipId);
    for (const [testId, value] of [
      ['timeline-clip-scale-x', PLACED.scalePercent],
      ['timeline-clip-x', String(Math.round(PLACED.frameX * LANDSCAPE.width))],
      ['timeline-clip-y', String(Math.round(PLACED.frameY * LANDSCAPE.height))],
    ] as const) {
      const field = outlet.getByTestId(testId);
      await field.fill(value);
      await field.press('Enter');
      await expect(field).toHaveValue(value);
    }
    await expectAt(page, spaceId, uploaded.clipId, LANDSCAPE);

    await withTimelinePeer(page, browser, projectId, 'viewer', async (peer) => {
      const peerErrors = watchTimelineErrors(peer);
      peerErrors.mediaUrls.add(uploaded.asset.fileUrl);
      await peer.goto(projectUrl);
      await openTimeline(peer, spaceId);
      const view = visibleSpace(peer);
      await expectAt(peer, spaceId, uploaded.clipId, LANDSCAPE);
      await expect(view.getByTestId('timeline-frame-ratio')).toBeDisabled();

      await outlet.getByTestId('timeline-frame-ratio').click();
      await page.getByRole('option', { name: PORTRAIT.label, exact: true }).click();
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await expectAt(page, spaceId, uploaded.clipId, PORTRAIT);
      await expectAt(peer, spaceId, uploaded.clipId, PORTRAIT);
      await expect(view.getByTestId('timeline-frame-ratio')).toBeDisabled();

      await outlet.getByTestId('timeline-undo').click();
      await expectAt(page, spaceId, uploaded.clipId, LANDSCAPE);
      await expectAt(peer, spaceId, uploaded.clipId, LANDSCAPE);
      await expect(view.getByTestId('timeline-frame-ratio')).toBeDisabled();
      expect(peerErrors.unexpected).toEqual([]);
    });
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});
