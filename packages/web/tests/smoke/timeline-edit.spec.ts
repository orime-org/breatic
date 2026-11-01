// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Multi-track clip editing with the pointer and keyboard on real uploaded video (inner#1708). */
import { expect, type Locator, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { test } from '../helpers/slot';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { addProjectTimelineVideo, timelineClipIds, uploadTimelineVideo, watchTimelineErrors } from '../helpers/timeline-media';

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
