// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every batch-one mini-tool run once for real (inner#888 A11, A12): the model
 * tools against their pinned WaveSpeed models, the container tools in the
 * ingest Worker's container. Each source is uploaded through the canvas, each
 * tool is opened from the node's Tools submenu and run from its panel, and a
 * result counts when the downstream node holds a stored URL.
 *
 * It spends money upstream and needs an ingest Worker serving this checkout's
 * `/jobs`; its tags keep it out of the default run. Run it with:
 *
 *   MINI_TOOLS_REAL_RUN=<directory with the media below> \
 *     pnpm --filter @breatic/web exec playwright test --project=smoke canvas-mini-tools-real-run
 *
 * The directory holds `portrait.jpg` (a face), `speech.mp3` (a few seconds of
 * speech), `song.mp3` (speech over a tone), `short720.mp4` (a clip with sound),
 * `silent.mp4` (no audio stream), `shaky.mp4` (a moving crop of a still
 * pattern), `driving.mp4` (a person moving) and `long1080.mp4` (60 s of 1080p
 * with sound).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { STATE_FILE, openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

const MEDIA = process.env.MINI_TOOLS_REAL_RUN ?? '';

test.use({ storageState: STATE_FILE.A, actionTimeout: 20_000 });
test.setTimeout(45 * 60_000);

/** One node as the document holds it. */
interface DocNode {
  id: string;
  type: string;
  content: string;
  name: string;
}

/** One run: the tool, its source and what it is handed. */
interface Run {
  label: string;
  tool: string;
  source: string;
  slots?: Record<string, string>;
  prompt?: string;
  /** Result nodes the run builds. */
  outputs: number;
  /** Set when the run must fail instead, with the task row's cause. */
  fails?: string;
}

let page: Page;
let projectId = '';
let spaceId = '';
/** Uploaded source nodes by file name. */
const sources = new Map<string, string>();
/** Result node ids by run label. */
const results = new Map<string, string[]>();

/**
 * The canvas document's nodes.
 * @returns Every node, with its content.
 */
async function documentNodes(): Promise<DocNode[]> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => {
          nodes: { id: string; type: string; data?: { content?: string; name?: string } }[];
        };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => ({
        id: n.id,
        type: n.type,
        content: n.data?.content ?? '',
        name: n.data?.name ?? '',
      }));
    },
    [projectId, spaceId, at] as [string, string, string],
  );
}

/**
 * Upload one file and wait for its node to hold a stored URL.
 * @param file - The file name in the media directory.
 * @returns The node id.
 */
async function upload(file: string): Promise<string> {
  const before = new Set((await documentNodes()).map((n) => n.id));
  const mimeType = file.endsWith('.jpg')
    ? 'image/jpeg'
    : file.endsWith('.mp3')
      ? 'audio/mpeg'
      : 'video/mp4';
  await page
    .locator('input[data-testid="canvas-upload-input"][multiple]')
    .setInputFiles([{ name: file, mimeType, buffer: readFileSync(join(MEDIA, file)) }]);
  let id = '';
  await expect
    .poll(
      async () => {
        const made = (await documentNodes()).find((n) => !before.has(n.id) && /^https?:\/\//.test(n.content));
        id = made?.id ?? '';
        return id;
      },
      { timeout: 5 * 60_000, intervals: [2_000] },
    )
    .not.toBe('');
  // Every upload lands where the last one did; the sources line up in one row.
  await moveNode(id, { x: sources.size * 450, y: 0 });
  return id;
}

/**
 * Move a node in the canvas document.
 * @param nodeId - The node.
 * @param to - Its new position.
 */
async function moveNode(nodeId: string, to: { x: number; y: number }): Promise<void> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  await page.evaluate(
    async ([pid, sid, id, x, y, url]: [string, string, string, number, number, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        setNodePosition: (p: string, s: string, n: string, at: { x: number; y: number }, parent: null) => void;
      };
      canvas.setNodePosition(pid, sid, id, { x, y }, null);
    },
    [projectId, spaceId, nodeId, to.x, to.y, at] as [string, string, string, number, number, string],
  );
}

/**
 * Open a tool from a node's Tools submenu.
 * @param nodeId - The source node.
 * @param tool - The tool id.
 */
async function openTool(nodeId: string, tool: string): Promise<void> {
  const node = visibleSpace(page).locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible();
  await node.click({ button: 'right' });
  await page.getByTestId('node-menu-tools').hover();
  await page.getByTestId(`node-menu-tool-${tool}`).click();
  await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId('mini-tool-panel-title')).toBeVisible();
}

/**
 * Start one run from its panel and record the nodes it built.
 * @param run - The run.
 */
async function start(run: Run): Promise<void> {
  await openTool(sources.get(run.source)!, run.tool);
  for (const [slot, file] of Object.entries(run.slots ?? {})) {
    await page.getByTestId(`mini-tool-slot-${run.tool}-${slot}`).click();
    await visibleSpace(page).locator(`.react-flow__node[data-id="${sources.get(file)!}"]`).click();
  }
  if (run.prompt !== undefined) await page.getByTestId('mini-tool-prompt').fill(run.prompt);
  const before = new Set((await documentNodes()).map((n) => n.id));
  await page.getByTestId('mini-tool-run').click();
  let made: string[] = [];
  await expect
    .poll(
      async () => {
        made = (await documentNodes()).filter((n) => !before.has(n.id)).map((n) => n.id);
        return made.length;
      },
      { timeout: 30_000 },
    )
    .toBe(run.outputs);
  results.set(run.label, made);
  // Results open beside their source, over the next one in the row; they are
  // read from the document, so they move off below, out of the way.
  for (const [i, id] of made.entries()) await moveNode(id, { x: results.size * 450, y: 3000 + i * 500 });
  await page.keyboard.press('Escape');
}

/**
 * A stored URL's streams, read by ffprobe.
 * @param url - The URL.
 * @returns ffprobe's JSON.
 */
function probe(url: string): {
  streams: { codec_type: string; codec_name: string; color_transfer?: string; color_primaries?: string; pix_fmt?: string }[];
  format: { duration?: string };
} {
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', url], {
      encoding: 'utf8',
    }),
  ) as ReturnType<typeof probe>;
}

/**
 * Mean frame-to-frame motion vidstab measures in a clip, in pixels.
 * @param url - The clip.
 * @returns The mean absolute shift of its local motions.
 */
function jitter(url: string): number {
  const trf = join(MEDIA, `jitter-${String(Math.abs(url.length))}-${String(results.size)}.trf`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', url, '-vf', `vidstabdetect=result=${trf}`, '-f', 'null', '-']);
  const shifts = [...readFileSync(trf, 'utf8').matchAll(/\(LM (-?\d+) (-?\d+)/g)].map(
    (m) => Math.abs(Number(m[1])) + Math.abs(Number(m[2])),
  );
  return shifts.reduce((a, b) => a + b, 0) / Math.max(1, shifts.length);
}

const RUNS: Run[] = [
  { label: 'remove background', tool: 'image.remove-bg', source: 'portrait.jpg', outputs: 1 },
  { label: 'upscale image', tool: 'image.upscale', source: 'portrait.jpg', outputs: 1 },
  { label: 'talking head', tool: 'image.digital-human', source: 'portrait.jpg', slots: { audio: 'speech.mp3' }, prompt: 'Calm, friendly, looking at the camera', outputs: 1 },
  { label: 'upscale video', tool: 'video.upscale', source: 'short720.mp4', outputs: 1 },
  { label: 'interpolate', tool: 'video.interpolate', source: 'short720.mp4', outputs: 1 },
  { label: 'extend video', tool: 'video.extend', source: 'short720.mp4', prompt: 'The pattern keeps scrolling', outputs: 1 },
  { label: 'edit video', tool: 'video.edit', source: 'short720.mp4', prompt: 'Make the colours warmer', outputs: 1 },
  { label: 'motion transfer', tool: 'video.motion', source: 'driving.mp4', slots: { character: 'portrait.jpg' }, prompt: 'A man dancing', outputs: 1 },
  { label: 'animate', tool: 'video.animate', source: 'driving.mp4', slots: { character: 'portrait.jpg' }, prompt: 'A man in a plain room', outputs: 1 },
  { label: 'separate vocals', tool: 'audio.separate', source: 'song.mp3', outputs: 2 },
  { label: 'extend audio', tool: 'audio.extend', source: 'speech.mp3', prompt: 'Soft room tone', outputs: 1 },
  { label: 'crop video', tool: 'video.crop', source: 'short720.mp4', outputs: 1 },
  { label: 'speed', tool: 'video.speed', source: 'short720.mp4', outputs: 1 },
  { label: 'cut', tool: 'video.cut', source: 'short720.mp4', outputs: 1 },
  { label: 'adjust', tool: 'video.adjust', source: 'short720.mp4', outputs: 1 },
  { label: 'denoise', tool: 'video.audio-denoise', source: 'short720.mp4', outputs: 1 },
  { label: 'stabilize', tool: 'video.stabilize', source: 'shaky.mp4', outputs: 1 },
  { label: 'hdr', tool: 'video.hdr', source: 'short720.mp4', outputs: 1 },
  { label: 'speed a minute of 1080p', tool: 'video.speed', source: 'long1080.mp4', outputs: 1 },
  { label: 'denoise a silent video', tool: 'video.audio-denoise', source: 'silent.mp4', outputs: 1, fails: 'no_audio_track' },
];

test.beforeAll(async ({ browser }) => {
  if (MEDIA === '') throw new Error('MINI_TOOLS_REAL_RUN must name the directory holding the media this run uploads');
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await openSmokeProject(page);
  projectId = smokeProjectId();
  spaceId = await createSpace(page, 'canvas', `mini-tools-real-${String(process.pid)}`);
});

test.afterAll(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
});

test('every tool runs to a result, and the silent denoise fails as such @needs-model @needs-ingest @needs-ffmpeg @needs-internet', async () => {
  // The sources upload here, under this case's budget: through the local
  // ingest Worker each part crosses to R2, which outlasts a hook's budget.
  for (const file of ['speech.mp3', 'portrait.jpg', 'driving.mp4', 'song.mp3', 'short720.mp4', 'silent.mp4', 'shaky.mp4', 'long1080.mp4']) {
    sources.set(file, await upload(file));
  }
  await page.getByRole('button', { name: 'Fit to viewport' }).click();
  for (const run of RUNS) await start(run);

  const pending = new Set(RUNS.filter((run) => run.fails === undefined).map((run) => run.label));
  await expect
    .poll(
      async () => {
        const nodes = new Map((await documentNodes()).map((n) => [n.id, n]));
        for (const label of pending) {
          const ids = results.get(label)!;
          if (ids.every((id) => /^https?:\/\//.test(nodes.get(id)?.content ?? ''))) pending.delete(label);
        }
        return [...pending];
      },
      { timeout: 40 * 60_000, intervals: [15_000] },
    )
    .toEqual([]);

  const nodes = new Map((await documentNodes()).map((n) => [n.id, n]));
  const out = (label: string): string => nodes.get(results.get(label)![0]!)!.content;

  // A12: what each container tool made is what its name says.
  const hdr = probe(out('hdr')).streams.find((s) => s.codec_type === 'video')!;
  expect(hdr.color_primaries).toBe('bt2020');
  expect(['smpte2084', 'arib-std-b67']).toContain(hdr.color_transfer);
  expect(hdr.pix_fmt).toContain('10le');
  expect(jitter(out('stabilize'))).toBeLessThan(jitter(nodes.get(sources.get('shaky.mp4')!)!.content));
  expect(Number(probe(out('cut')).format.duration)).toBeGreaterThan(7);
  expect(probe(out('denoise')).streams.map((s) => s.codec_type)).toContain('audio');
  expect(Number(probe(out('speed a minute of 1080p')).format.duration)).toBeLessThan(40);
  // Two result nodes for the two stems.
  expect(results.get('separate vocals')).toHaveLength(2);
});
