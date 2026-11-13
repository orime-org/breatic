// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every batch-six video mini-tool run once for real (inner#1306): each source
 * is uploaded through the canvas, each tool is opened from the node's Tools
 * submenu and configured through its own panel, Run is pressed, and a result
 * counts once every node the run built holds a stored URL. ffprobe then reads
 * what was stored.
 *
 * The model tools spend money upstream, every tool runs in the ingest
 * Worker's containers, and the media are drawn by ffmpeg as the run starts;
 * the tags keep each case out of the default run. Everything runs at the
 * lowest settings: short, small clips, one output, the first model offered.
 *
 * `driving.mp4` (a person moving, with sound) and `speech.mp3` (a few seconds
 * of speech) are fixtures made with our own generators; this run cuts them
 * short. The rest is ffmpeg's animated test pattern over a tone.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { roomForUploads } from '../helpers/upload-budget';

/** The fixtures with people in them. */
const FIXTURES = resolve(__dirname, '../fixtures/mini-tools');

/** Where this run's media are put together. */
let MEDIA = '';

/**
 * Run ffmpeg quietly, failing on any error.
 * @param args - Its arguments after the global flags.
 */
function ffmpeg(...args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

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
  clip('clip3b.mp4', '640x360', 3, 550);
  clip('square3.mp4', '480x480', 3, 660);
  ffmpeg('-i', join(FIXTURES, 'driving.mp4'), '-t', '3', ...mp4, join(dir, 'driving3.mp4'));
  // The same person at an odd size, and with an alpha channel: VP9 WebM carries both, H.264 neither.
  const webm = ['-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-shortest', ...mark];
  ffmpeg('-i', join(FIXTURES, 'driving.mp4'), '-t', '3', '-vf', 'scale=853:481', '-pix_fmt', 'yuv420p', ...webm, join(dir, 'driving3odd.webm'));
  ffmpeg('-i', join(FIXTURES, 'driving.mp4'), '-t', '3', '-vf', 'format=yuva420p,geq=lum=\'lum(X,Y)\':cb=\'cb(X,Y)\':cr=\'cr(X,Y)\':a=\'if(lt(X,16),0,255)\'',
    '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', ...webm, join(dir, 'driving3alpha.webm'));
  ffmpeg('-i', join(FIXTURES, 'speech.mp3'), '-t', '2', ...mark, join(dir, 'speech2.mp3'));
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

/** One canvas a case works on. */
interface Canvas {
  page: Page;
  projectId: string;
  spaceId: string;
  /** Uploaded sources by file name. */
  sources: Map<string, string>;
}

/** One node as the document holds it, with what a waiting case reports. */
interface DocNode {
  id: string;
  type: string;
  content: string;
  data: Record<string, unknown>;
}

/**
 * Open a Space of the case's own on the slot's Project.
 * @param page - The case's page.
 * @param label - A name for the Space.
 * @returns The canvas.
 */
async function openCanvas(page: Page, label: string): Promise<Canvas> {
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'canvas', `batch-6-${label}-${String(Date.now())}`);
  return { page, projectId: smokeProjectId(), spaceId, sources: new Map() };
}

/**
 * The canvas document's nodes.
 * @param c - The canvas.
 * @returns Every node, with its content and the fields a failure report needs.
 */
async function documentNodes(c: Canvas): Promise<DocNode[]> {
  const at = await liveModuleUrl(c.page, CANVAS_SPACE);
  return c.page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => {
          nodes: { id: string; type: string; data?: Record<string, unknown> }[];
        };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => {
        const data = n.data ?? {};
        const pick = Object.fromEntries(['state', 'taskCounts', 'errorMessage', 'duration', 'width', 'height', 'coverUrl']
          .filter((key) => key in data).map((key) => [key, data[key]]));
        return { id: n.id, type: n.type, content: typeof data.content === 'string' ? data.content : '', data: pick };
      });
    },
    [c.projectId, c.spaceId, at] as [string, string, string],
  );
}

/**
 * Move a node in the canvas document.
 * @param c - The canvas.
 * @param nodeId - The node.
 * @param to - Its new position.
 * @param to.x - Flow x.
 * @param to.y - Flow y.
 */
async function moveNode(c: Canvas, nodeId: string, to: { x: number; y: number }): Promise<void> {
  const at = await liveModuleUrl(c.page, CANVAS_SPACE);
  await c.page.evaluate(
    async ([pid, sid, id, x, y, url]: [string, string, string, number, number, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        setNodePosition: (p: string, s: string, n: string, at: { x: number; y: number }, parent: null) => void;
      };
      canvas.setNodePosition(pid, sid, id, { x, y }, null);
    },
    [c.projectId, c.spaceId, nodeId, to.x, to.y, at] as [string, string, string, number, number, string],
  );
}

/**
 * Upload the case's sources through the canvas, one at a time, and line them up.
 * @param c - The canvas.
 * @param files - File names in the media directory.
 */
async function upload(c: Canvas, ...files: string[]): Promise<void> {
  await roomForUploads(files.length);
  for (const file of files) {
    const before = new Set((await documentNodes(c)).map((n) => n.id));
    await c.page.locator('input[data-testid="canvas-upload-input"][multiple]').setInputFiles(join(MEDIA, file));
    let id = '';
    await expect
      .poll(async () => {
        const made = (await documentNodes(c)).find((n) => !before.has(n.id) && /^https?:\/\//.test(n.content));
        id = made?.id ?? '';
        return id;
      }, { timeout: 5 * 60_000, intervals: [2_000] })
      .not.toBe('');
    await moveNode(c, id, { x: c.sources.size * 700, y: 0 });
    c.sources.set(file, id);
  }
  await c.page.getByRole('button', { name: 'Fit to viewport' }).click();
}

/**
 * A source's stored URL.
 * @param c - The canvas.
 * @param file - Its file name.
 * @returns The URL its node holds.
 */
async function contentOf(c: Canvas, file: string): Promise<string> {
  return (await documentNodes(c)).find((n) => n.id === c.sources.get(file))!.content;
}

/**
 * A source node on screen.
 * @param c - The canvas.
 * @param file - Its file name.
 * @returns Its locator.
 */
function nodeOf(c: Canvas, file: string): Locator {
  return visibleSpace(c.page).locator(`.react-flow__node[data-id="${c.sources.get(file)!}"]`);
}

/**
 * Wait until a video source plays through its presentation.
 * @param c - The canvas.
 * @param file - Its file name.
 */
async function presented(c: Canvas, file: string): Promise<void> {
  const media = nodeOf(c, file).getByTestId('media-element');
  await expect(media).toBeAttached({ timeout: 5 * 60_000 });
  // An alpha-packed presentation draws on a canvas, which the player marks only after its first frame is drawn.
  await expect.poll(() => media.evaluate((el) => el instanceof HTMLVideoElement ? el.readyState >= 2 : el instanceof HTMLCanvasElement)).toBe(true);
}

/**
 * Seek a video node through its own seek bar, as a reader drags the playhead.
 * @param c - The canvas.
 * @param file - The source.
 * @param fraction - Where along the bar.
 * @returns The time the player shows afterwards.
 */
async function seek(c: Canvas, file: string, fraction: number): Promise<number> {
  const node = nodeOf(c, file);
  const media = node.getByTestId('media-element');
  await node.hover();
  const bar = node.getByTestId('seek');
  const box = await bar.boundingBox();
  if (box === null) throw new Error('the seek bar has no box');
  await c.page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  let at = 0;
  await expect
    .poll(async () => {
      at = await media.evaluate((el: HTMLMediaElement) => el.currentTime);
      return at;
    })
    .toBeGreaterThan(0);
  return at;
}

/**
 * Open a tool from a node's Tools submenu.
 * @param c - The canvas.
 * @param file - The source.
 * @param tool - The tool id.
 */
async function openTool(c: Canvas, file: string, tool: string): Promise<void> {
  const node = nodeOf(c, file);
  await expect(node).toBeVisible();
  await node.click({ button: 'right' });
  await c.page.getByTestId('node-menu-tools').hover();
  await c.page.getByTestId(`node-menu-tool-${tool}`).click();
  await expect(c.page.getByRole('menu')).toHaveCount(0, { timeout: 5_000 });
  await expect(c.page.getByTestId('mini-tool-panel-title')).toBeVisible();
}

/**
 * Press a Run and return the nodes it built.
 * @param c - The canvas.
 * @param press - The press itself.
 * @param outputs - How many nodes the run builds.
 * @returns Their ids.
 */
async function runBuilding(c: Canvas, press: () => Promise<void>, outputs: number): Promise<string[]> {
  const before = new Set((await documentNodes(c)).map((n) => n.id));
  const toasts = new Set<string>();
  await press();
  let made: string[] = [];
  // The value polled names any toast the press raised, so a refused press
  // ends in a timeout that says why.
  await expect
    .poll(async () => {
      made = (await documentNodes(c)).filter((n) => !before.has(n.id)).map((n) => n.id);
      for (const text of await c.page.locator('[data-sonner-toast]').allInnerTexts()) toasts.add(text);
      return made.length === outputs ? 'built' : JSON.stringify({ built: made.length, toasts: [...toasts] });
    }, { timeout: 60_000, intervals: [250] })
    .toBe('built');
  return made;
}

/**
 * Press the panel's Run once it can run.
 * @param c - The canvas.
 * @param outputs - How many nodes the run builds.
 * @returns Their ids.
 */
async function run(c: Canvas, outputs: number): Promise<string[]> {
  const button = c.page.getByTestId('mini-tool-run');
  await expect(button).toBeEnabled({ timeout: 5 * 60_000 });
  await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  return runBuilding(c, () => button.click(), outputs);
}

/**
 * Wait until every node a run built holds a stored URL.
 * @param c - The canvas.
 * @param ids - The run's nodes.
 * @returns Them, as the document holds them.
 * @throws {Error} When a task of the run fails, or nothing is stored in time.
 */
async function stored(c: Canvas, ids: readonly string[]): Promise<DocNode[]> {
  const deadline = Date.now() + 25 * 60_000;
  for (;;) {
    const all = new Map((await documentNodes(c)).map((n) => [n.id, n]));
    const nodes = ids.map((id) => all.get(id)!);
    if (nodes.every((n) => /^https?:\/\//.test(n.content))) return nodes;
    // A failed task ends the wait at once, naming what each node shows.
    const involved = [...nodes, ...[...c.sources.values()].map((id) => all.get(id)!)];
    const failed = involved.some((n) => ((n.data.taskCounts as { failed?: number } | undefined)?.failed ?? 0) > 0);
    if (failed || Date.now() > deadline) {
      throw new Error(`the run stored no result: ${JSON.stringify(involved.map((n) => ({ id: n.id, content: n.content, ...n.data })))}`);
    }
    await c.page.waitForTimeout(10_000);
  }
}

/** What ffprobe reads off one stored URL. */
interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    duration?: string;
    tags?: Record<string, string>;
  }[];
  format: { duration?: string };
}

/**
 * A stored URL's streams, read by ffprobe.
 * @param url - The URL.
 * @returns ffprobe's JSON.
 */
function probe(url: string): Probe {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', url], { encoding: 'utf8' }),
  ) as Probe;
}

/**
 * A stored media's running time.
 * @param url - The URL.
 * @returns Seconds.
 */
function duration(url: string): number {
  return Number(probe(url).format.duration);
}

/**
 * The video stream of a stored URL.
 * @param url - The URL.
 * @returns Its stream.
 */
function videoStream(url: string): Probe['streams'][number] {
  const stream = probe(url).streams.find((s) => s.codec_type === 'video');
  if (stream === undefined) throw new Error(`${url} has no video stream`);
  return stream;
}

/**
 * The last frame of a stored video, small and grey, so two encodes of the same picture compare by their mean difference.
 * @param url - The URL.
 * @returns Its 64 x 36 grey pixels.
 */
function lastFrame(url: string): Buffer {
  const size = 64 * 36;
  const tail = execFileSync('ffmpeg', ['-v', 'error', '-sseof', '-0.5', '-i', url, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', 'pipe:']);
  return tail.subarray(tail.length - size);
}

/**
 * How far two grey frames differ, as the mean of their pixel differences.
 * @param a - One frame.
 * @param b - The other, of the same size.
 * @returns The mean difference, 0 to 255.
 */
function pictureDifference(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += Math.abs(a[index]! - b[index]!);
  return sum / a.length;
}

/** One frame at 25 fps, the tolerance a duration is held to. */
const FRAME = 0.04;

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
      expect(node!.type).toBe('image');
      results.push(node!);
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
    await expect(firstCut).toHaveValue('1.5');
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
    await expect(c.page.getByTestId('video-cut-1')).toHaveValue(/^5\.96666\d$/);
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

test('transitions: two videos and a crossfade give one video as long as both less the overlap @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'transitions');
  try {
    await upload(c, 'clip3a.mp4', 'clip3b.mp4');
    await presented(c, 'clip3a.mp4');
    await presented(c, 'clip3b.mp4');
    await openTool(c, 'clip3a.mp4', 'video.transitions');
    // One input slot; the current video is never a slot (canvas design invariant 11.2).
    const slot = c.page.getByTestId('video-timeline-input');
    await expect(slot).toHaveCount(1);
    await expect(c.page.getByTestId('video-timeline-clear')).toHaveCount(0);
    await slot.click();
    await nodeOf(c, 'clip3b.mp4').click();
    await expect(c.page.getByTestId('video-timeline-thumbnail')).toHaveCount(1);
    // Picking the video opens the timeline (canvas design §4 transitions row).
    const dialog = c.page.getByTestId('video-timeline-dialog');
    await expect(dialog).toBeVisible();
    // Both clips are drawn on the track; the timeline library lays it out only with its stylesheet loaded.
    const trackClips = dialog.locator('.timeline-editor-action');
    await expect(trackClips).toHaveCount(2);
    for (const clip of await trackClips.all()) expect((await clip.boundingBox())?.height ?? 0).toBeGreaterThan(0);
    const fontOf = (target: Locator): Promise<string> => target.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(await fontOf(trackClips.first())).toBe(await fontOf(dialog));
    // The clip picker, then the transition's type.
    await dialog.getByRole('combobox').nth(1).click();
    await c.page.getByRole('option', { name: 'Crossfade' }).click();
    const overlap = dialog.getByTestId('video-clip-overlap');
    await overlap.fill('1');
    await expect(overlap).toHaveValue('1');
    // The track redraws with the two clips overlapping by the transition.
    const [firstClip, secondClip] = [trackClips.first(), trackClips.last()];
    await expect.poll(async () => ((await firstClip.boundingBox())?.x ?? 0) + ((await firstClip.boundingBox())?.width ?? 0) - ((await secondClip.boundingBox())?.x ?? 0)).toBeGreaterThan(50);
    // Only the selected clip (the first, selected on open) is outlined, inside its own box so the track row cannot clip it.
    const shadowOf = (target: Locator): Promise<string> => target.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await shadowOf(firstClip)).toContain('inset');
    expect(await shadowOf(secondClip)).toBe('none');
    // Each box and its hit test are read in one page evaluation, so a track redraw between them cannot move the clips.
    const hits = (): Promise<Record<string, boolean>> => dialog.evaluate((root) => {
      const [first, second] = [...root.querySelectorAll('.timeline-editor-action')];
      const at = (el: Element, x: number, y: number): boolean => el.contains(document.elementFromPoint(x, y));
      const middle = (el: Element): [number, number] => { const box = el.getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; };
      const [a, b] = [first!.getBoundingClientRect(), second!.getBoundingClientRect()];
      return {
        overlap: at(first!, (b.x + a.x + a.width) / 2, a.y + 4),
        firstEnd: at(first!, ...middle(first!.querySelector('.timeline-editor-action-right-stretch')!)),
        secondStart: at(second!, ...middle(second!.querySelector('.timeline-editor-action-left-stretch')!)),
      };
    });
    // With the first clip selected, it is drawn on top where the clips overlap, so its whole range stays visible, and the
    // second clip's left resize handle still sits above it, so that clip's in point can be dragged there.
    await expect.poll(async () => { const { overlap, secondStart } = await hits(); return { overlap, secondStart }; }).toEqual({ overlap: true, secondStart: true });
    // With the second clip selected and raised, the first clip's right resize handle still sits above it, so the first
    // clip's out point can be dragged there; then the first clip is selected again for the drags below.
    const clickInside = async (clip: Locator, fromLeft: boolean): Promise<void> => {
      const box = (await clip.boundingBox())!;
      await c.page.mouse.click(fromLeft ? box.x + 20 : box.x + box.width - 20, box.y + box.height / 2);
    };
    await clickInside(secondClip, false);
    await expect.poll(() => shadowOf(secondClip)).toContain('inset');
    await expect.poll(async () => (await hits()).firstEnd).toBe(true);
    await clickInside(firstClip, true);
    await expect.poll(() => shadowOf(firstClip)).toContain('inset');
    // The track's scroll grids have no keyboard use, so Tab never stops on them.
    expect(await dialog.locator('.ReactVirtualized__Grid').evaluateAll((grids) => grids.filter((grid) => (grid as HTMLElement).tabIndex >= 0).length)).toBe(0);
    const handle = (await firstClip.locator('.timeline-editor-action-right-stretch').boundingBox())!;
    const [x, y] = [handle.x + handle.width / 2, handle.y + handle.height / 2];
    const outField = dialog.getByTestId('video-clip-out');
    const outBefore = Number(await outField.inputValue());
    // Dragging that end past the clip's other end stops at a clip that still has length, with no page error.
    const pageErrors: string[] = [];
    c.page.on('pageerror', (error) => pageErrors.push(error.message));
    const firstLeft = (await firstClip.boundingBox())!.x;
    await c.page.mouse.move(x, y);
    await c.page.mouse.down();
    await c.page.mouse.move(firstLeft - 40, y, { steps: 20 });
    await c.page.mouse.up();
    await expect.poll(async () => Number(await outField.inputValue())).toBeLessThan(outBefore);
    expect(Number(await outField.inputValue())).toBeGreaterThan(Number(await dialog.getByTestId('video-clip-in').inputValue()));
    expect(pageErrors).toEqual([]);
    // The short clip shortened the transition to fit; put both back so the clips overlap as before.
    await outField.fill(String(outBefore));
    await expect(outField).toHaveValue(String(outBefore));
    await overlap.fill('1');
    await expect(overlap).toHaveValue('1');
    await c.page.mouse.move(x, y);
    await c.page.mouse.down();
    await c.page.mouse.move(x - 100, y, { steps: 10 });
    await c.page.mouse.up();
    await expect.poll(async () => Number(await outField.inputValue())).toBeLessThan(outBefore);
    // The trim may shorten the transition to fit; the export follows what the fields now hold.
    const firstLength = Number(await outField.inputValue()) - Number(await dialog.getByTestId('video-clip-in').inputValue());
    const finalOverlap = Number(await overlap.inputValue());
    const made = await runBuilding(c, () => dialog.getByRole('button', { name: 'Export' }).click(), 1);
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    const [joined] = await stored(c, made);
    const b = duration(await contentOf(c, 'clip3b.mp4'));
    expect(Math.abs(duration(joined!.content) - (firstLength + b - finalOverlap))).toBeLessThanOrEqual(2 * FRAME);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('transitions: a second video at a lower rate keeps every frame, so the picture lasts as long as the composition @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'transitions-rates');
  try {
    // 30 fps first sets the output grid; the 25 fps second clip covers more output frames than it has frames of its own.
    await upload(c, 'clip6at30.mp4', 'clip3a.mp4');
    await presented(c, 'clip6at30.mp4');
    await presented(c, 'clip3a.mp4');
    await openTool(c, 'clip6at30.mp4', 'video.transitions');
    await c.page.getByTestId('video-timeline-input').click();
    await nodeOf(c, 'clip3a.mp4').click();
    const dialog = c.page.getByTestId('video-timeline-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/30 fps · 9\.0\d\d s/)).toBeVisible();
    const made = await runBuilding(c, () => dialog.getByRole('button', { name: 'Export' }).click(), 1);
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    const [joined] = await stored(c, made);
    const whole = duration(await contentOf(c, 'clip6at30.mp4')) + duration(await contentOf(c, 'clip3a.mp4'));
    expect(Math.abs(Number(videoStream(joined!.content).duration) - whole)).toBeLessThanOrEqual(2 * FRAME);
    // The picture ends on the second video's last frame. Measured on this test pattern: a re-encode of the same frame differs
    // by about 0.15, the frame before it by about 2.9.
    expect(pictureDifference(lastFrame(joined!.content), lastFrame(await contentOf(c, 'clip3a.mp4')))).toBeLessThan(1);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('transitions: the preview plays two videos of different sizes, before and after Swap order @needs-ingest @needs-storage', async ({ page }) => {
  const c = await openCanvas(page, 'transitions-preview');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await upload(c, 'driving3.mp4', 'clip3b.mp4');
    await presented(c, 'driving3.mp4');
    await presented(c, 'clip3b.mp4');
    await openTool(c, 'driving3.mp4', 'video.transitions');
    await c.page.getByTestId('video-timeline-input').click();
    await nodeOf(c, 'clip3b.mp4').click();
    const dialog = c.page.getByTestId('video-timeline-dialog');
    await expect(dialog).toBeVisible();
    const readout = dialog.getByText(/^\d+\.\d{3} \/ \d+\.\d{3} s$/);
    const played = async (): Promise<number> => Number((await readout.textContent())!.split(' / ')[0]);
    // The ruler labels each second up to the one after the composition's end, and no label is cut at the right edge.
    const total = Number.parseFloat((await readout.textContent())!.split(' / ')[1]!);
    const labels = await dialog.locator('.timeline-editor-time-unit-scale').evaluateAll((elements) => elements.map((element) => {
      const editor = element.closest('.timeline-editor')!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return { text: element.textContent ?? '', inside: box.left >= editor.left && box.right <= editor.right };
    }).filter((label) => label.text !== ''));
    expect(labels.at(-1)?.text).toBe(`${String(Math.ceil(total))}s`);
    expect(labels.filter((label) => !label.inside)).toEqual([]);
    // The 1280 x 720 clip first: each frame costs the most here, where the preview once failed within a second.
    for (const step of ['before swap', 'after swap'] as const) {
      if (step === 'after swap') {
        await dialog.getByRole('button', { name: 'Swap order' }).click();
        await dialog.getByRole('button', { name: 'Back to start' }).click();
        await expect.poll(played).toBe(0);
      }
      await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect.poll(played, { message: step, timeout: 15_000 }).toBeGreaterThan(1.5);
      await expect(dialog.getByText('Preview unavailable. Try again.'), step).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Pause' }).click();
    }
    // An edit remounts the track; its playhead stays at the paused time, as the readout does.
    const paused = await played();
    const cursorLeft = (): Promise<number> => dialog.locator('.timeline-editor-cursor').first().evaluate((el) => {
      const editor = el.closest('.timeline-editor')!.getBoundingClientRect();
      return el.getBoundingClientRect().left - editor.left;
    });
    const before = await cursorLeft();
    await dialog.getByRole('button', { name: 'Swap order' }).click();
    await expect(dialog.getByText('Preview unavailable. Try again.')).toHaveCount(0);
    expect(await played()).toBeCloseTo(paused, 2);
    await expect.poll(async () => Math.abs((await cursorLeft()) - before)).toBeLessThan(2);
    // A crossfade length typed key by key keeps every key.
    await dialog.getByRole('combobox').filter({ hasNotText: /^\d+\./ }).click();
    await c.page.getByRole('option', { name: 'Crossfade' }).click();
    const overlap = dialog.getByTestId('video-clip-overlap');
    await overlap.click({ clickCount: 3 });
    await c.page.keyboard.type('0.5');
    await expect(overlap).toHaveValue('0.5');
    await expect(overlap).toHaveAttribute('aria-invalid', 'false');
    // An Out typed key by key is written when the field is left, so its keys (Out 2 on the way to 2.9) keep a 1.4 s crossfade.
    await overlap.fill('1.4');
    await overlap.press('Enter');
    const inField = dialog.getByTestId('video-clip-in');
    const outField = dialog.getByTestId('video-clip-out');
    await outField.click({ clickCount: 3 });
    await c.page.keyboard.type('2.9');
    await c.page.keyboard.press('Enter');
    await expect(outField).toHaveValue('2.9');
    await expect(overlap).toHaveValue('1.4');
    // Tab from an Out typed key by key goes on to the transition type, the next control.
    await outField.click({ clickCount: 3 });
    await c.page.keyboard.type('2.95');
    await c.page.keyboard.press('Tab');
    await expect(dialog.getByRole('combobox').filter({ hasNotText: /^\d+\./ })).toBeFocused();
    // A length past the limit is clamped to it, and Tab from it still goes on to a control rather than the dialog.
    await overlap.click({ clickCount: 3 });
    await c.page.keyboard.type('9');
    await c.page.keyboard.press('Tab');
    await expect(overlap).toHaveAttribute('aria-invalid', 'false');
    expect(Number(await overlap.inputValue())).toBeLessThan(9);
    expect(await dialog.evaluate((root, field) => document.activeElement !== field && document.activeElement !== root && root.contains(document.activeElement) && document.activeElement instanceof HTMLElement && document.activeElement.tabIndex >= 0, await overlap.elementHandle())).toBe(true);
    // An In refused under its Out is stored once the Out moves past it, and the track shows it.
    await outField.fill('2');
    await outField.press('Enter');
    await inField.fill('2.5');
    await expect(inField).toHaveAttribute('aria-invalid', 'true');
    await outField.fill('2.8');
    await outField.press('Enter');
    await expect(inField).toHaveAttribute('aria-invalid', 'false');
    await expect(dialog.getByText('2.50 s → 2.80 s')).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('remove background: the result carries an alpha channel @needs-model @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'remove-bg');
  try {
    await upload(c, 'driving3.mp4');
    await presented(c, 'driving3.mp4');
    await openTool(c, 'driving3.mp4', 'video.remove-bg');
    const made = await run(c, 1);
    await c.page.keyboard.press('Escape');
    const [matte] = await stored(c, made);
    const stream = videoStream(matte!.content);
    // An alpha plane in the pixel format, or WebM's side-channel alpha (its ALPHA_MODE tag).
    const tags = Object.fromEntries(Object.entries(stream.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const alpha = /a/.test((stream.pix_fmt ?? '').replace(/^yuv/, '').replace(/^gbr/, '')) || tags.alpha_mode === '1';
    expect(alpha, JSON.stringify(stream)).toBe(true);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

/**
 * Lip-sync one person of a video to one line of dialogue and check the result lasts until the shorter of the two ends.
 * @param c - The canvas.
 * @param video - The source video's file name.
 * @returns The stored result node.
 */
async function lipSync(c: Canvas, video: string): Promise<DocNode> {
  await upload(c, video, 'speech2.mp3');
  await presented(c, video);
  await openTool(c, video, 'video.lip-sync');
  // The panel identifies the people itself once the source is presented.
  const row = c.page.locator('[data-testid^="video-dialogue-"]');
  await expect(row).toHaveCount(1);
  const dialogue = (await row.getAttribute('data-testid'))!.slice('video-dialogue-'.length);
  const person = c.page.getByTestId(`video-person-${dialogue}`);
  await expect(person).toBeEnabled({ timeout: 10 * 60_000 });
  await person.click();
  await c.page.getByRole('option', { name: 'Person 1' }).click();
  const audio = c.page.getByTestId(`video-audio-${dialogue}`);
  await audio.click();
  await nodeOf(c, 'speech2.mp3').click();
  await expect(c.page.getByTestId(`video-audio-clear-${dialogue}`)).toBeAttached();
  await audio.click();
  const made = await run(c, 1);
  await c.page.keyboard.press('Escape');
  const [synced] = await stored(c, made);
  // Cut off, the panel's default: the result lasts until the shorter of the video and the dialogue ends.
  const expected = Math.min(duration(await contentOf(c, video)), duration(await contentOf(c, 'speech2.mp3')));
  expect(synced!.type).toBe('video');
  expect(Math.abs(duration(synced!.content) - expected)).toBeLessThanOrEqual(2 * FRAME);
  return synced!;
}

// Execution design §9: an odd-sized source's masks and faces are read at the prepared video's size and laid onto the output.
test('lip-sync: an odd-sized video gives one video as long as the result @needs-model @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'lip-sync-odd');
  try {
    const stream = videoStream((await lipSync(c, 'driving3odd.webm')).content);
    // An opaque odd side is taken down to even for the H.264 result.
    expect([stream.width, stream.height]).toEqual([852, 480]);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

// Execution design §9: a transparent source gives a VP9 WebM result that keeps its alpha.
test('lip-sync: a transparent video gives a result that keeps its alpha @needs-model @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'lip-sync-alpha');
  try {
    const synced = await lipSync(c, 'driving3alpha.webm');
    const stream = videoStream(synced.content);
    const tags = Object.fromEntries(Object.entries(stream.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    expect(/a/.test((stream.pix_fmt ?? '').replace(/^yuv/, '')) || tags.alpha_mode === '1', JSON.stringify(stream)).toBe(true);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('lip-sync: one person and one line of dialogue give one video as long as the result @needs-model @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'lip-sync');
  try {
    expect((await lipSync(c, 'driving3.mp4')).type).toBe('video');
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('erase: a tracked region is erased into one video that keeps its sound @needs-model @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'erase');
  try {
    await upload(c, 'driving3.mp4');
    await presented(c, 'driving3.mp4');
    await openTool(c, 'driving3.mp4', 'video.erase');
    const area = nodeOf(c, 'driving3.mp4').getByTestId('video-tool-region-gesture');
    await expect(area).toBeVisible({ timeout: 60_000 });
    const box = await area.boundingBox();
    if (box === null) throw new Error('the region area has no box');
    await c.page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.2);
    await c.page.mouse.down();
    await c.page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.8, { steps: 8 });
    await c.page.mouse.up();
    const track = c.page.getByRole('button', { name: 'Track selection' });
    await expect(track).toBeEnabled();
    await track.click();
    const made = await run(c, 1);
    await c.page.keyboard.press('Escape');
    const [erased] = await stored(c, made);
    expect(probe(erased!.content).streams.map((s) => s.codec_type)).toEqual(expect.arrayContaining(['video', 'audio']));
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});

test('expand: a widened frame gives one video larger than the source @needs-model @needs-ingest @needs-storage @needs-ffmpeg', async ({ page }) => {
  const c = await openCanvas(page, 'expand');
  try {
    await upload(c, 'square3.mp4');
    await presented(c, 'square3.mp4');
    await openTool(c, 'square3.mp4', 'video.expand');
    await c.page.getByTestId('video-expand-ratios').getByRole('button', { name: '16:9' }).click();
    const made = await run(c, 1);
    await c.page.keyboard.press('Escape');
    const [expanded] = await stored(c, made);
    const before = videoStream(await contentOf(c, 'square3.mp4'));
    const after = videoStream(expanded!.content);
    expect(after.width! * after.height!).toBeGreaterThan(before.width! * before.height!);
    expect(after.width! / after.height!).toBeCloseTo(16 / 9, 1);
  } finally {
    await deleteSpace(page, c.spaceId);
  }
});
