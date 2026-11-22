// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every part-one batch-six video mini-tool run once for real (inner#1306): each source
 * is uploaded through the canvas, each tool is opened from the node's Tools
 * submenu and configured through its own panel, Run is pressed, and a result
 * counts once every node the run built holds a stored URL. ffprobe then reads
 * what was stored.
 *
 * Every tool runs in the ingest Worker's containers, and the media are drawn
 * by ffmpeg as the run starts; the tags keep each case out of the default run.
 * Everything runs at the lowest settings: short, small clips. The media are
 * ffmpeg's animated test pattern over a tone.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { deleteSpace } from '../helpers/space';
import {
  contentOf, duration, ffmpeg, FRAME, nodeOf, openCanvas as openVideoCanvas, openTool, presented, run, seek, stored, upload, videoStream,
  type Canvas, type DocNode,
} from '../helpers/video-canvas';

/** Where this run's media are put together. */
let MEDIA = '';

/**
 * Put the run's media in a directory of their own. Every file carries a mark
 * of this run, so its bytes are ones the studio has not stored before.
 * @returns The directory.
 */
function prepareMedia(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mini-tools-batch-6-'));
  const mark = ['-metadata', `comment=mini-tools-batch-6 ${String(Date.now())}`];
  const mp4 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', ...mark];
  const clip = (name: string, size: string, seconds: number, hz: number): void => ffmpeg(
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${String(seconds)}`,
    '-f', 'lavfi', '-i', `sine=frequency=${String(hz)}:duration=${String(seconds)}`,
    ...mp4, join(dir, name),
  );
  clip('clip6.mp4', '640x360', 6, 330);
  // 30 fps, so most frame starts are not whole microseconds, which the browser rounds a seek target to.
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=370:duration=6',
    ...mp4, join(dir, 'clip6at30.mp4'));
  clip('clip3a.mp4', '640x360', 3, 440);
  return dir;
}

test.use({ viewport: { width: 1680, height: 950 }, actionTimeout: 20_000 });
// Each case uploads, prepares presentations and waits for a container or model
// run to finish; the slowest, a model run, takes several minutes.
test.setTimeout(30 * 60_000);

test.beforeAll(() => {
  MEDIA = prepareMedia();
});

test.afterAll(() => {
  if (MEDIA !== '') rmSync(MEDIA, { recursive: true, force: true });
});

/**
 * Open a Space of the case's own on the slot's Project.
 * @param page - The case's page.
 * @param label - A name for the Space.
 * @returns The canvas.
 */
function openCanvas(page: Page, label: string): Promise<Canvas> {
  return openVideoCanvas(page, `batch-6-${label}`, MEDIA);
}

test('extract frames: first, last and current frame each give one image @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'frames');
  try {
    await upload(c, 'clip3a.mp4');
    await presented(c, 'clip3a.mp4');
    const source = videoStream(await contentOf(c, 'clip3a.mp4'));
    const results: DocNode[] = [];
    for (const mode of ['first', 'last', 'current'] as const) {
      if (mode === 'current') await seek(c, 'clip3a.mp4', 0.5);
      await openTool(c, 'clip3a.mp4', 'video.extract-frames');
      await c.page.getByTestId(`video-frame-mode-${mode}`).click();
      await expect(c.page.getByTestId(`video-frame-mode-${mode}`)).toHaveAttribute('aria-current', 'true');
      const made = await run(c, 1);
      await c.page.keyboard.press('Escape');
      const [node] = await stored(c, made);
      expect(node.type).toBe('image');
      results.push(node);
    }
    for (const node of results) {
      const frame = videoStream(node.content);
      expect([frame.width, frame.height]).toEqual([source.width, source.height]);
    }
    expect(new Set(results.map((n) => n.content)).size).toBe(3);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('split: two cut points give three videos that add up to the source @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'split');
  try {
    await upload(c, 'clip6.mp4');
    await presented(c, 'clip6.mp4');
    await openTool(c, 'clip6.mp4', 'video.split');
    const atCursor = c.page.getByRole('button', { name: 'Add at cursor' });
    for (const [index, fraction] of [0.33, 0.66].entries()) {
      await seek(c, 'clip6.mp4', fraction);
      await atCursor.click();
      await expect(c.page.getByTestId(`video-cut-${String(index)}`)).toBeVisible();
    }
    // While the source plays, the panel strip's playhead follows it.
    const media = nodeOf(c, 'clip6.mp4').getByTestId('media-element');
    const head = c.page.getByTestId('video-playback-head');
    const headAt = (): Promise<string> => head.evaluate((el) => (el as HTMLElement).style.left);
    const before = await headAt();
    await media.evaluate((el: HTMLMediaElement) => { el.muted = true; void el.play(); });
    await expect.poll(headAt, { timeout: 5_000 }).not.toBe(before);
    await media.evaluate((el: HTMLMediaElement) => { el.pause(); });
    // A plain click on a cut handle focuses it and leaves the cut where it is.
    const firstCut = c.page.getByTestId('video-cut-0');
    const cutBefore = await firstCut.inputValue();
    const handleBox = (await c.page.getByTestId('video-cut-handle-0').boundingBox())!;
    await c.page.mouse.click(handleBox.x + handleBox.width / 2 + 8, handleBox.y + handleBox.height / 2);
    await expect(c.page.getByTestId('video-cut-handle-0')).toBeFocused();
    expect(await firstCut.inputValue()).toBe(cutBefore);
    // A typed cut keeps exactly what was typed while typing.
    const secondCut = c.page.getByTestId('video-cut-1');
    await secondCut.fill('');
    await secondCut.pressSequentially('4.55');
    await expect(secondCut).toHaveValue('4.55');
    // Pressing a second segment while the first is still starting previews the second one.
    await c.page.evaluate(() => {
      for (const id of ['video-segment-0', 'video-segment-1']) (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).click();
    });
    await expect(c.page.getByTestId('video-segment-preview')).toBeVisible();
    await expect(c.page.getByText('Media unavailable')).toHaveCount(0);
    await c.page.getByRole('button', { name: 'Stop preview' }).click();
    // A seek past the end of the segment being previewed ends the preview where the user put the playhead.
    await c.page.getByTestId('video-segment-0').click();
    await expect(c.page.getByTestId('video-segment-preview')).toBeVisible();
    const track = (await c.page.getByTestId('video-playback-track').boundingBox())!;
    await c.page.mouse.click(track.x + track.width * 0.9, track.y + track.height / 2);
    await expect(c.page.getByTestId('video-segment-preview')).toHaveCount(0);
    await c.page.waitForTimeout(1_000);
    expect(await media.evaluate((el: HTMLMediaElement) => el.currentTime)).toBeGreaterThan(5);
    await media.evaluate((el: HTMLMediaElement) => { el.pause(); });
    // Typing a smaller cut into the second row edits that row in place; the rows sort when the field is left.
    const firstBefore = await firstCut.inputValue();
    await secondCut.fill('');
    for (const key of '1.5') {
      await secondCut.press(key);
      expect(await firstCut.inputValue()).toBe(firstBefore);
      await expect(secondCut).toBeFocused();
    }
    await expect(secondCut).toHaveValue('1.5');
    await secondCut.press('Tab');
    // A row shows the millisecond start of the grid frame its time lands in: 1.5 s is inside frame 37 at 25 fps.
    await expect(firstCut).toHaveValue('1.48');
    await expect(secondCut).toHaveValue(firstBefore);
    // The first ArrowLeft on a handle moves it one frame back.
    const handle0 = c.page.getByTestId('video-cut-handle-0');
    const leftOf = (): Promise<string> => handle0.evaluate((el) => (el as HTMLElement).style.left);
    const handleBefore = await leftOf();
    await handle0.focus();
    await c.page.keyboard.press('ArrowLeft');
    await expect.poll(leftOf).not.toBe(handleBefore);
    const made = await run(c, 3);
    await c.page.keyboard.press('Escape');
    const parts = await stored(c, made);
    expect(parts.every((n) => n.type === 'video')).toBe(true);
    const total = parts.reduce((sum, n) => sum + duration(n.content), 0);
    const whole = duration(await contentOf(c, 'clip6.mp4'));
    expect(Math.abs(total - whole)).toBeLessThanOrEqual(2 * FRAME);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('split: a 30 fps video previews a segment between frames and keeps typed rows while others change @needs-ingest @needs-storage', async ({ page }) => {
  const c = await openCanvas(page, 'split-30fps');
  try {
    await upload(c, 'clip6at30.mp4');
    await presented(c, 'clip6at30.mp4');
    await openTool(c, 'clip6at30.mp4', 'video.split');
    const editor = c.page.getByTestId('video-cut-editor');
    for (const fraction of [0.5, 0.8]) {
      await seek(c, 'clip6at30.mp4', fraction);
      await c.page.getByTestId('video-add-cut').click();
    }
    await expect(c.page.getByTestId('video-cut-1')).toBeVisible();
    // 1.04 s falls inside frame 31, whose start 31/30 s is not a whole microsecond.
    const first = c.page.getByTestId('video-cut-0');
    await first.fill('1.04');
    await first.press('Tab');
    const secondEnd = Number(await c.page.getByTestId('video-cut-1').inputValue());
    const media = nodeOf(c, 'clip6at30.mp4').getByTestId('media-element');
    await media.evaluate((el: HTMLMediaElement) => { el.muted = true; });
    await c.page.getByTestId('video-segment-1').click();
    await expect(c.page.getByTestId('video-segment-preview')).toBeVisible();
    await expect.poll(() => media.evaluate((el: HTMLMediaElement) => el.paused), { timeout: 10_000 }).toBe(true);
    expect(Math.abs(await media.evaluate((el: HTMLMediaElement) => el.currentTime) - secondEnd)).toBeLessThan(0.1);
    // A third cut, then type into the middle row and remove the first: the typed row keeps the focus and its text.
    await seek(c, 'clip6at30.mp4', 0.95);
    await c.page.getByTestId('video-add-cut').click();
    await expect(c.page.getByTestId('video-cut-2')).toBeVisible();
    const middle = c.page.getByTestId('video-cut-1');
    await middle.fill('');
    await middle.pressSequentially('3.3');
    await editor.getByRole('button', { name: 'Remove', exact: true }).first().click();
    const focused = c.page.locator('input:focus');
    await expect(focused).toHaveValue('3.3');
    await focused.press('Tab');
    await expect(c.page.getByTestId('video-cut-0')).toHaveValue('3.3');
    // Typing a value that reorders the rows, then dragging a handle, moves that handle.
    const last = c.page.getByTestId('video-cut-1');
    await last.fill('');
    await last.pressSequentially('2');
    const handle = c.page.getByTestId('video-cut-handle-0');
    const box = (await handle.boundingBox())!;
    const track = (await c.page.getByTestId('video-playback-track').boundingBox())!;
    const before = await handle.evaluate((el) => (el as HTMLElement).style.left);
    await c.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await c.page.mouse.down();
    await c.page.mouse.move(track.x + track.width * 0.1, box.y + box.height / 2, { steps: 8 });
    await c.page.mouse.up();
    await expect.poll(() => handle.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(before);
    // A handle dropped past the right end stays on the last frame (179/30 s) and its row shows that frame start.
    const dragged = (await handle.boundingBox())!;
    await c.page.mouse.move(dragged.x + dragged.width / 2, dragged.y + dragged.height / 2);
    await c.page.mouse.down();
    await c.page.mouse.move(track.x + track.width + 40, dragged.y + dragged.height / 2, { steps: 8 });
    await c.page.mouse.up();
    await expect(c.page.getByTestId('video-cut-1')).toHaveValue('5.967');
    // A row left showing text that is no number keeps Run blocked after another row is removed.
    const runButton = c.page.getByTestId('mini-tool-run');
    await expect(runButton).toBeEnabled();
    await c.page.getByTestId('video-cut-1').fill('abc');
    await expect(runButton).toBeDisabled();
    await editor.getByRole('button', { name: 'Remove', exact: true }).first().click();
    await expect(c.page.getByTestId('video-cut-0')).toHaveValue('abc');
    await expect(c.page.getByText('Enter a valid number.')).toBeVisible();
    await expect(runButton).toBeDisabled();
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});
