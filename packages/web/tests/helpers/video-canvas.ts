// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canvas video cases that run for real (inner#1306): media drawn by ffmpeg, uploaded through the canvas, played through
 * the node, run through the video tools' panels, and what was stored read back by ffprobe.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';
import type { VideoPresentationResponse } from '@breatic/shared';

import { dataOf } from './api';
import { CANVAS_SPACE, liveModuleUrl } from './live-module';
import { openSmokeProject, smokeProjectId } from './project';
import { createSpace, visibleSpace } from './space';
import { roomForUploads } from './upload-budget';

/**
 * Run ffmpeg quietly, failing on any error.
 * @param args - Its arguments after the global flags.
 */
export function ffmpeg(...args: string[]): void {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

/** One canvas a case works on. */
export interface Canvas {
  page: Page;
  projectId: string;
  spaceId: string;
  /** The directory the case's media are drawn in. */
  media: string;
  /** Uploaded sources by file name. */
  sources: Map<string, string>;
}

/** One node as the document holds it, with what a waiting case reports. */
export interface DocNode {
  id: string;
  type: string;
  content: string;
  data: Record<string, unknown>;
}

/**
 * Open a Space of the case's own on the slot's Project.
 * @param page - The case's page.
 * @param label - A name for the Space.
 * @param media - Where the case's media are.
 * @returns The canvas.
 */
export async function openCanvas(page: Page, label: string, media: string): Promise<Canvas> {
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'canvas', `${label}-${String(Date.now())}`);
  return { page, projectId: smokeProjectId(), spaceId, media, sources: new Map() };
}

/**
 * The canvas document's nodes, as one page holds them.
 * @param c - The canvas.
 * @param page - The page whose copy of the document is read; the canvas's own page when absent.
 * @returns Every node, with its content and the fields a failure report needs.
 */
export async function documentNodes(c: Canvas, page: Page = c.page): Promise<DocNode[]> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => {
          nodes: { id: string; type: string; data?: Record<string, unknown> }[];
        };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => {
        const data = n.data ?? {};
        const pick = Object.fromEntries(['state', 'taskCounts', 'errorMessage', 'duration', 'width', 'height', 'coverUrl', 'focusImages']
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
export async function moveNode(c: Canvas, nodeId: string, to: { x: number; y: number }): Promise<void> {
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
export async function upload(c: Canvas, ...files: string[]): Promise<void> {
  await roomForUploads(files.length);
  for (const file of files) {
    const before = new Set((await documentNodes(c)).map((n) => n.id));
    await c.page.locator('input[data-testid="canvas-upload-input"][multiple]').setInputFiles(join(c.media, file));
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
export async function contentOf(c: Canvas, file: string): Promise<string> {
  return (await documentNodes(c)).find((n) => n.id === c.sources.get(file))!.content;
}

/**
 * A source node on screen.
 * @param c - The canvas.
 * @param file - Its file name.
 * @param page - The page it is looked for on; the canvas's own page when absent.
 * @returns Its locator.
 */
export function nodeOf(c: Canvas, file: string, page: Page = c.page): Locator {
  return visibleSpace(page).locator(`.react-flow__node[data-id="${c.sources.get(file)!}"]`);
}

/**
 * Wait until a video source plays through its presentation.
 * @param c - The canvas.
 * @param file - Its file name.
 */
export async function presented(c: Canvas, file: string): Promise<void> {
  const media = nodeOf(c, file).getByTestId('media-element');
  await expect(media).toBeAttached({ timeout: 5 * 60_000 });
  // An alpha-packed presentation draws on a canvas, which the player marks only after its first frame is drawn.
  await expect.poll(() => media.evaluate((el) => el instanceof HTMLVideoElement ? el.readyState >= 2 : el instanceof HTMLCanvasElement), { timeout: 60_000 }).toBe(true);
}

/**
 * Seek a video node through its own seek bar, as a user drags the playhead.
 * @param c - The canvas.
 * @param file - The source.
 * @param fraction - Where along the bar.
 * @returns The time the player shows afterwards.
 */
export async function seek(c: Canvas, file: string, fraction: number): Promise<number> {
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
 * @param page - The page that opens it; the canvas's own page when absent.
 */
export async function openToolMenu(c: Canvas, file: string, tool: string, page: Page = c.page): Promise<void> {
  const node = nodeOf(c, file, page);
  await expect(node).toBeVisible();
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-tools').hover();
  await page.getByTestId(`node-menu-tool-${tool}`).click();
  await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('mini-tool-panel-title')).toBeVisible();
}

/**
 * Open a tool from a node's Tools submenu and wait until its controls work: the node plays its original while the
 * presentation is still being prepared, and the panel enables its controls only once a version is selected.
 * @param c - The canvas.
 * @param file - The source.
 * @param tool - The tool id.
 * @param page - The page that opens it; the canvas's own page when absent.
 */
export async function openTool(c: Canvas, file: string, tool: string, page: Page = c.page): Promise<void> {
  await openToolMenu(c, file, tool, page);
  await expect(page.getByTestId('mini-tool-panel').getByText('Preparing video…')).toHaveCount(0, { timeout: 5 * 60_000 });
}

/**
 * Press a Run and return the nodes it built.
 * @param c - The canvas.
 * @param press - The press itself.
 * @param outputs - How many nodes the run builds.
 * @returns Their ids.
 */
export async function runBuilding(c: Canvas, press: () => Promise<void>, outputs: number): Promise<string[]> {
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
export async function run(c: Canvas, outputs: number): Promise<string[]> {
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
export async function stored(c: Canvas, ids: readonly string[]): Promise<DocNode[]> {
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
export interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    duration?: string;
    tags?: Record<string, string>;
  }[];
  format: { duration?: string; format_name?: string };
}

/**
 * A stored URL's streams, read by ffprobe.
 * @param url - The URL.
 * @returns ffprobe's JSON.
 */
export function probe(url: string): Probe {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', url], { encoding: 'utf8' }),
  ) as Probe;
}

/**
 * A stored media's running time.
 * @param url - The URL.
 * @returns Seconds.
 */
export function duration(url: string): number {
  return Number(probe(url).format.duration);
}

/**
 * The video stream of a stored URL.
 * @param url - The URL.
 * @returns Its stream.
 */
export function videoStream(url: string): Probe['streams'][number] {
  const stream = probe(url).streams.find((s) => s.codec_type === 'video');
  if (stream === undefined) throw new Error(`${url} has no video stream`);
  return stream;
}

/** One frame at 25 fps, the tolerance a duration is held to. */
export const FRAME = 0.04;

/**
 * The presentation answer for one registered video, read the way the page reads it.
 * @param page - A signed-in page.
 * @param projectId - The Project.
 * @param url - The registered original.
 * @returns The answer.
 */
export async function presentationOf(page: Page, projectId: string, url: string): Promise<VideoPresentationResponse> {
  return dataOf<VideoPresentationResponse>(
    await page.request.get(`/api/v1/projects/${projectId}/assets/video-presentation`, { params: { url } }),
    'read the video presentation',
  );
}

/**
 * The playback file of a source's selected version, once one is selected.
 * @param page - A signed-in page.
 * @param projectId - The Project.
 * @param url - The registered original.
 * @returns The playback file's URL.
 */
export async function playbackOf(page: Page, projectId: string, url: string): Promise<string> {
  let carrier = '';
  await expect.poll(async () => {
    carrier = (await presentationOf(page, projectId, url)).presentation?.playback.carrier.url ?? '';
    return carrier;
  }, { timeout: 10 * 60_000, intervals: [3_000] }).not.toBe('');
  return carrier;
}

/**
 * Open a Space that already exists through the drawer, as a second user would.
 * @param page - A page inside its Project.
 * @param spaceId - The Space.
 */
export async function openExistingSpace(page: Page, spaceId: string): Promise<void> {
  await page.getByTestId('space-drawer-trigger').click();
  const drawer = page.getByTestId('space-drawer');
  await expect(drawer).toBeVisible();
  await drawer.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button', { name: /Open/ }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator(`[data-space-outlet="${spaceId}"]`)).toBeVisible();
}
