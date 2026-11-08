// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Multi-track clip editing with the pointer and keyboard on real uploaded video (inner#1708). */
import { expect, type Locator, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import {
  addProjectTimelineVideo, moveTimelineClip, timelineClipIds, uploadTimelineVideo, watchTimelineErrors,
} from '../helpers/timeline-media';

/** dnd-kit swallows clicks for 50 ms after a drag ends; a person never clicks that fast. */
const AFTER_DRAG_MS = 100;

/**
 * Drag with the real mouse from the centre of one element by a horizontal offset to a vertical target.
 * @param page - The page.
 * @param handle - What the pointer presses.
 * @param dx - The horizontal travel in pixels.
 * @param toY - The vertical position to release at, or null to keep the row.
 * @throws {Error} When the handle has no geometry.
 */
async function drag(page: Page, handle: Locator, dx: number, toY: number | null): Promise<void> {
  const box = await handle.boundingBox();
  if (box === null) throw new Error('The drag handle has no geometry');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Cross dnd-kit's activation distance before travelling to the target.
  await page.mouse.move(x + Math.sign(dx || 1) * 8, y, { steps: 4 });
  await page.mouse.move(x + dx, toY ?? y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(AFTER_DRAG_MS);
}

test.use({ viewport: { width: 1680, height: 1100 } });

test('an Editor drags a clip onto a new track, trims, splits, duplicates, deletes, undoes and removes the emptied track @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline edit ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const second = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    const outlet = visibleSpace(page);
    const clipOf = (id: string): Locator => outlet.getByTestId(`timeline-clip-${id}`);
    const tracks = outlet.locator('[data-testid^="timeline-track-"]');
    await expect(tracks).toHaveCount(1);
    await expect(clipOf(second)).toHaveAttribute('data-track-id', 'visual-1');
    // Zoom out to the minimum, which fits the whole Timeline, so every clip and handle is on screen.
    const zoom = outlet.getByTestId('timeline-zoom').getByRole('slider');
    await zoom.focus();
    await zoom.press('Home');
    await expect(clipOf(second)).toBeInViewport();

    // Drag the second clip into the new-track zone.
    const zone = await outlet.getByTestId('timeline-new-track-zone').boundingBox();
    if (zone === null) throw new Error('The new-track zone has no geometry');
    await drag(page, clipOf(second), 40, zone.y + zone.height / 2);
    await expect(tracks).toHaveCount(2);
    const newTrack = await clipOf(second).getAttribute('data-track-id');
    expect(newTrack).not.toBe('visual-1');
    expect(newTrack).not.toBe(null);
    await expect(clipOf(second)).toHaveAttribute('aria-pressed', 'true');

    // Trim its right edge by a quarter of its width.
    const duration = outlet.getByTestId('timeline-clip-duration');
    const before = Number(await duration.inputValue());
    const width = (await clipOf(second).boundingBox())?.width ?? 0;
    await drag(page, outlet.getByTestId(`timeline-trim-end-${second}`), -Math.round(width / 4), null);
    await expect.poll(async () => Number(await duration.inputValue())).toBeLessThan(before);

    // Split the first clip at frame 10 with Cmd/Ctrl+B.
    await clipOf(uploaded.clipId).click();
    await expect(clipOf(uploaded.clipId)).toHaveAttribute('aria-pressed', 'true');
    const seek = outlet.getByRole('slider', { name: 'Preview frame', exact: true });
    await seek.focus();
    await seek.press('Home');
    for (let step = 0; step < 10; step += 1) await seek.press('ArrowRight');
    await expect(seek).toHaveAttribute('aria-valuenow', '10');
    await clipOf(uploaded.clipId).focus();
    await page.keyboard.press('ControlOrMeta+b');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(3);

    // Duplicate the selected clip with Cmd/Ctrl+D, delete the copy, then undo the delete.
    await page.keyboard.press('ControlOrMeta+d');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(4);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(3);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(4);

    // Redo the delete from the toolbar and with Cmd/Ctrl+Shift+Z, undoing each so the copy is back.
    await outlet.getByTestId('timeline-redo').click();
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(3);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(4);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(3);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(4);
    await expect(outlet.getByTestId('timeline-redo')).toBeEnabled();

    // Delete the clip on the new track, then the track it leaves empty.
    await clipOf(second).click();
    await expect(clipOf(second)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Delete');
    await expect(clipOf(second)).toHaveCount(0);
    await outlet.getByTestId(`timeline-delete-track-${newTrack ?? ''}`).click();
    await expect(outlet.getByTestId(`timeline-track-${newTrack ?? ''}`)).toHaveCount(0);
    await expect(tracks).toHaveCount(1);
    await expect.poll(async () => (await timelineClipIds(page)).length).toBe(3);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('the preview shows the upper layer where a sub-track clip covers a main clip and the main clip elsewhere @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline layers ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const upper = await addProjectTimelineVideo(page, uploaded.asset.assetId);
    const duration = uploaded.durationFrames;
    const half = Math.floor(duration / 2);
    // The main clip covers [0, duration); the upper clip covers [half, half + duration) on a new track above it.
    await moveTimelineClip(page, upper, half, duration, 'New visual track');
    const outlet = visibleSpace(page);
    const preview = outlet.getByTestId('timeline-preview');
    const seek = outlet.getByRole('slider', { name: 'Preview frame', exact: true });
    await seek.focus();
    await seek.press('Home');
    await expect(seek).toHaveAttribute('aria-valuenow', '0');
    await expect(preview).toHaveAttribute('data-active-clip-id', uploaded.clipId);
    // Radix PageUp advances ten frames; stop at the first multiple of ten inside the covered part.
    const pages = Math.ceil(half / 10);
    expect(pages * 10).toBeLessThan(duration);
    for (let step = 0; step < pages; step += 1) await seek.press('PageUp');
    await expect(seek).toHaveAttribute('aria-valuenow', String(pages * 10));
    await expect(preview).toHaveAttribute('data-active-clip-id', upper);
    await seek.press('Home');
    await expect(preview).toHaveAttribute('data-active-clip-id', uploaded.clipId);
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

/**
 * Add the registered upload through Add media onto a chosen track at a typed start frame.
 * @param page - The Editor's page.
 * @param assetId - The registered upload.
 * @param track - The visible name of the track option.
 * @param start - The typed start frame.
 * @returns The new clip's id.
 * @throws {Error} When the dialog cannot select the video or the clip does not appear.
 */
async function addProjectVideoTo(page: Page, assetId: string, track: string, start: number): Promise<string> {
  const before = await timelineClipIds(page);
  await visibleSpace(page).getByTestId('timeline-add-media').click();
  const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
  await dialog.getByTestId('timeline-material-project').click();
  const choice = dialog.getByTestId(`timeline-project-video-${assetId}`);
  const more = dialog.getByRole('button', { name: 'Load more', exact: true });
  for (;;) {
    await expect(choice.or(more).first()).toBeVisible();
    if (await choice.count() > 0) break;
    await more.click();
  }
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByTestId('timeline-material-track').click();
  await page.getByRole('option', { name: track, exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await dialog.getByTestId('timeline-start-frame').fill(String(start));
  await dialog.getByTestId('timeline-confirm-material').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await timelineClipIds(page)).length).toBe(before.length + 1);
  const added = (await timelineClipIds(page)).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return added[0] ?? '';
}

test('Add media places a clip on a new visual track and on an existing sub track @needs-storage @needs-ingest', async ({ page }) => {
  const errors = watchTimelineErrors(page);
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'timeline', `Timeline add to track ${crypto.randomUUID()}`);
  try {
    const uploaded = await uploadTimelineVideo(page, smokeProjectId());
    errors.mediaUrls.add(uploaded.asset.fileUrl);
    const duration = uploaded.durationFrames;
    const outlet = visibleSpace(page);
    const tracks = outlet.locator('[data-testid^="timeline-track-"]');
    await expect(tracks).toHaveCount(1);

    const onNew = await addProjectVideoTo(page, uploaded.asset.assetId, 'New visual track', 0);
    await expect(tracks).toHaveCount(2);
    const created = await outlet.getByTestId(`timeline-clip-${onNew}`).getAttribute('data-track-id');
    expect(created).not.toBe(null);
    expect(created).not.toBe('visual-1');

    const onExisting = await addProjectVideoTo(page, uploaded.asset.assetId, 'Visual 2', duration);
    await expect(tracks).toHaveCount(2);
    await expect(outlet.getByTestId(`timeline-clip-${onExisting}`)).toHaveAttribute('data-track-id', created ?? '');
    await expect(outlet.getByTestId(`timeline-clip-${uploaded.clipId}`)).toHaveAttribute('data-track-id', 'visual-1');
    await outlet.getByTestId(`timeline-clip-${onExisting}`).click();
    await expect(outlet.getByTestId('timeline-clip-start')).toHaveValue(String(duration));
    expect(errors.unexpected).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});
