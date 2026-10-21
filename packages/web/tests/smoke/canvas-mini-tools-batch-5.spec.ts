// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The fifth batch of mini-tools, on audio (inner#1305): denoise, normalize,
 * speed, cut, equalizer, compressor, stereo, reverb, voice enhance, pitch
 * shift and enhance.
 *
 * What the unit suite cannot reach: the audio Tools submenu as the canvas
 * opens it, each panel's controls as the real panel draws and reads them, the
 * cut band's waveform decoded by wavesurfer.js from the file, and enhance's
 * ceilings told by a toast on Run. Those cases seed an audio node whose file
 * this spec serves itself, so they need nothing outside the stack.
 *
 * The last case runs every tool for real (@needs-model @needs-ingest
 * @needs-ffmpeg @needs-internet): two sources uploaded through the canvas,
 * each tool run from its panel, and each stored result read by ffprobe.
 *
 * Needs a running dev stack (`pnpm dev`).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { openTool, seedNode } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

/** The fixtures with people in them. */
const FIXTURES = resolve(__dirname, '../fixtures/mini-tools');

/** Where the seeded node's file is served from, by this spec. */
const SERVED = 'https://smoke-audio.test/speech.mp3';

/** The audio tools in the order the Tools submenu lists them. */
const AUDIO_TOOLS = [
  'audio.denoise',
  'audio.normalize',
  'audio.speed',
  'audio.cut',
  'audio.eq',
  'audio.compress',
  'audio.pan',
  'audio.reverb',
  'audio.voice',
  'audio.pitch',
  'audio.enhance',
  'audio.separate',
  'audio.extend',
];

let page: Page;
let projectId = '';
let spaceId = '';
/** Audio nodes seeded in this case, so each lands beside the last. */
let seeded = 0;

/**
 * The node with this id on the visible Space.
 * @param id - The node.
 * @returns Its locator.
 */
function nodeOf(id: string): Locator {
  return visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`);
}

/**
 * Seed an audio node holding the served speech, with the length and size its
 * record would carry.
 * @param media - The length in seconds and the size in bytes.
 * @param media.duration - The length.
 * @param media.size - The size.
 * @returns The node id.
 */
async function seedAudio(media: { duration: number; size: number } = { duration: 6.144, size: 98_304 }): Promise<string> {
  const id = randomUUID();
  await seedNode(page, { projectId, spaceId }, id, 'audio', seeded++ * 320, { content: SERVED, mimeType: 'audio/mpeg', ...media });
  return id;
}

/**
 * Press a key on a slider's thumb.
 * @param slider - The slider's test id.
 * @param key - The key.
 * @param times - How many presses.
 */
async function nudge(slider: string, key: string, times = 1): Promise<void> {
  const thumb = page.getByTestId(slider).getByRole('slider').first();
  await thumb.focus();
  for (let i = 0; i < times; i += 1) await thumb.press(key);
}

test.describe('panels', () => {
  test.beforeEach(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    const speech = readFileSync(join(FIXTURES, 'speech.mp3'));
    await page.route('https://smoke-audio.test/**', (route) =>
      route.fulfill({
        status: 200,
        body: speech,
        headers: { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' },
      }),
    );
    await openSmokeProject(page);
    projectId = smokeProjectId();
    spaceId = await createSpace(page, 'canvas', `mini-tools-batch-5-${Date.now()}`);
    await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  });

  test.afterEach(async () => {
    // A menu left open, on a red case too, would sit over the Space's tab.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    if (spaceId !== '') await deleteSpace(page, spaceId);
    await page?.close();
    spaceId = '';
    seeded = 0;
  });

  test('the audio Tools submenu lists the eleven new tools ahead of separate and extend', async () => {
    const id = await seedAudio();
    await nodeOf(id).click({ button: 'right' });
    await page.getByTestId('node-menu-tools').hover();
    await expect(page.getByTestId('node-menu-tool-audio.denoise')).toBeVisible();
    const listed = await page
      .getByTestId('node-menu-tool-audio.denoise')
      .locator('xpath=..')
      .locator('[data-testid^="node-menu-tool-audio."]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace('node-menu-tool-', '')));
    expect(listed).toEqual(AUDIO_TOOLS);
  });

  test('normalize opens on podcasts with the peak limit noted, speed reads its rate and keeps pitch', async () => {
    const id = await seedAudio();
    await openTool(page, id, 'audio.normalize');
    await expect(page.getByTestId('mini-tool-param-target--16')).toHaveAttribute('aria-current', 'true');
    for (const target of ['-14', '-23', '-24']) {
      await expect(page.getByTestId(`mini-tool-param-target-${target}`)).toBeVisible();
    }
    await expect(page.getByTestId('mini-tool-note')).toHaveText('Peak limit −1 dBTP');
    await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
    await page.keyboard.press('Escape');

    await openTool(page, id, 'audio.speed');
    await expect(page.getByTestId('mini-tool-param-rate-value')).toHaveText('1×');
    await nudge('mini-tool-param-rate-slider', 'ArrowRight', 2);
    await expect(page.getByTestId('mini-tool-param-rate-value')).toHaveText('1.5×');
    const keep = page.getByTestId('mini-tool-param-keepPitch-switch');
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    await keep.click();
    await expect(keep).toHaveAttribute('aria-checked', 'false');
  });

  test('cut draws the waveform from the file, and a source past the ceiling keeps the band plain', async () => {
    const id = await seedAudio();
    await openTool(page, id, 'audio.cut');
    const band = page.getByTestId('mini-tool-range-band');
    // wavesurfer.js draws into a canvas inside its own shadow root.
    await expect
      .poll(
        () =>
          band.getByTestId('mini-tool-waveform').evaluate((box) => {
            const canvas = box.firstElementChild?.shadowRoot?.querySelector('canvas');
            return canvas === null || canvas === undefined ? 0 : canvas.width;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await expect(band.getByTestId('mini-tool-waveform')).toHaveAttribute('data-state', 'drawn');
    await page.keyboard.press('Escape');

    // Longer than the hour the band decodes.
    const long = await seedAudio({ duration: 4000, size: 98_304 });
    await openTool(page, long, 'audio.cut');
    await expect(page.getByTestId('mini-tool-range-band')).toBeVisible();
    await expect(page.getByTestId('mini-tool-waveform')).toHaveCount(0);
  });

  test('the equalizer fills its bands from a preset and turns Custom when one band moves', async () => {
    const id = await seedAudio();
    await openTool(page, id, 'audio.eq');
    await expect(page.getByTestId('mini-tool-eq-preset-flat')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('mini-tool-eq-preset-custom')).toHaveCount(0);
    await expect(page.getByTestId('mini-tool-eq-band-0-label')).toHaveText('31');
    await expect(page.getByTestId('mini-tool-eq-band-9-label')).toHaveText('16k');

    await page.getByTestId('mini-tool-eq-preset-bass_boost').click();
    await expect(page.getByTestId('mini-tool-eq-band-0-value')).toHaveText('+6');
    await expect(page.getByTestId('mini-tool-eq-band-9-value')).toHaveText('0');

    await nudge('mini-tool-eq-band-9-slider', 'ArrowDown', 3);
    await expect(page.getByTestId('mini-tool-eq-band-9-value')).toHaveText('-3');
    await expect(page.getByTestId('mini-tool-eq-preset-custom')).toHaveAttribute('aria-current', 'true');

    await page.getByTestId('mini-tool-eq-preset-flat').click();
    await expect(page.getByTestId('mini-tool-eq-preset-custom')).toHaveCount(0);
    await expect(page.getByTestId('mini-tool-eq-band-9-value')).toHaveText('0');
  });

  test('the compressor reads each setting in its unit and turns Custom when one moves', async () => {
    const id = await seedAudio();
    await openTool(page, id, 'audio.compress');
    await expect(page.getByTestId('mini-tool-dynamics-preset-medium')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('mini-tool-dynamics-threshold-value')).toHaveText('-24 dB');
    await expect(page.getByTestId('mini-tool-dynamics-ratio-value')).toHaveText('3:1');
    await expect(page.getByTestId('mini-tool-dynamics-attack-value')).toHaveText('10 ms');
    await expect(page.getByTestId('mini-tool-dynamics-makeup-value')).toHaveText('+4 dB');

    await page.getByTestId('mini-tool-dynamics-preset-heavy').click();
    await expect(page.getByTestId('mini-tool-dynamics-ratio-value')).toHaveText('6:1');
    await nudge('mini-tool-dynamics-ratio-slider', 'ArrowLeft');
    await expect(page.getByTestId('mini-tool-dynamics-preset-custom')).toHaveAttribute('aria-current', 'true');
  });

  test('stereo, reverb and pitch read their settings as a mix engineer would', async () => {
    const id = await seedAudio();
    await openTool(page, id, 'audio.pan');
    await expect(page.getByTestId('mini-tool-param-pan-value')).toHaveText('Center');
    await nudge('mini-tool-param-pan-slider', 'ArrowLeft', 2);
    await expect(page.getByTestId('mini-tool-param-pan-value')).toHaveText('L 2');
    await nudge('mini-tool-param-pan-slider', 'ArrowRight', 5);
    await expect(page.getByTestId('mini-tool-param-pan-value')).toHaveText('R 3');
    await expect(page.getByTestId('mini-tool-param-width-value')).toHaveText('100%');
    await page.keyboard.press('Escape');

    await openTool(page, id, 'audio.reverb');
    await expect(page.getByTestId('mini-tool-param-room-large_room')).toHaveAttribute('aria-current', 'true');
    for (const room of ['small_room', 'medium_room', 'church_hall', 'cathedral', 'bathroom']) {
      await expect(page.getByTestId(`mini-tool-param-room-${room}`)).toBeVisible();
    }
    await expect(page.getByTestId('mini-tool-param-amount-value')).toHaveText('50');
    await page.keyboard.press('Escape');

    await openTool(page, id, 'audio.pitch');
    await expect(page.getByTestId('mini-tool-param-semitones-value')).toHaveText('0');
    await nudge('mini-tool-param-semitones-slider', 'ArrowRight', 3);
    await expect(page.getByTestId('mini-tool-param-semitones-value')).toHaveText('+3');
    await nudge('mini-tool-param-cents-slider', 'ArrowLeft', 20);
    await expect(page.getByTestId('mini-tool-param-cents-value')).toHaveText('-20');
  });

  test('enhance reads its strength as a percentage and tells its ceilings on Run', async () => {
    const id = await seedAudio();
    await openTool(page, id, 'audio.enhance');
    await expect(page.getByTestId('generate-param-strength-value')).toHaveText('85%');
    await page.keyboard.press('Escape');

    const nodes = visibleSpace(page).locator('.react-flow__node');
    // Half an hour is the model's longest; this is a minute more.
    const long = await seedAudio({ duration: 31 * 60, size: 98_304 });
    await openTool(page, long, 'audio.enhance');
    let before = await nodes.count();
    await expect(page.getByTestId('mini-tool-run')).toBeEnabled();
    await page.getByTestId('mini-tool-run').click();
    await expect(
      page.locator('[data-sonner-toast]').filter({ hasText: 'This tool takes audio up to 30 minutes long.' }),
    ).toBeVisible();
    await expect(nodes).toHaveCount(before);
    await page.keyboard.press('Escape');

    // 512 MiB is the model's largest file.
    const large = await seedAudio({ duration: 60, size: 600 * 1024 * 1024 });
    await openTool(page, large, 'audio.enhance');
    before = await nodes.count();
    await page.getByTestId('mini-tool-run').click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'This tool takes files up to' })).toBeVisible();
    await expect(nodes).toHaveCount(before);
  });
});

/** One node as the document holds it. */
interface DocNode {
  id: string;
  content: string;
}

/** One real run: the tool, its source and what is set on its panel first. */
interface Run {
  tool: string;
  source: 'speech.mp3' | 'music.wav';
  set?: () => Promise<void>;
}

/** Where this run's media are put together. */
let MEDIA = '';
/** Uploaded source nodes by file name. */
const sources = new Map<string, string>();
/** Result node ids by tool. */
const results = new Map<string, string>();

/**
 * The canvas document's nodes.
 * @returns Every node, with its content.
 */
async function documentNodes(): Promise<DocNode[]> {
  const at = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([pid, sid, url]: [string, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ url)) as {
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string; data?: { content?: string } }[] };
      };
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => ({ id: n.id, content: n.data?.content ?? '' }));
    },
    [projectId, spaceId, at] as [string, string, string],
  );
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
 * Upload one file and wait for its node to hold a stored URL.
 * @param file - The file name in the media directory.
 * @returns The node id.
 */
async function upload(file: string): Promise<string> {
  const before = new Set((await documentNodes()).map((n) => n.id));
  await page.locator('input[data-testid="canvas-upload-input"][multiple]').setInputFiles([
    { name: file, mimeType: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', buffer: readFileSync(join(MEDIA, file)) },
  ]);
  let id = '';
  await expect
    .poll(
      async () => {
        id = (await documentNodes()).find((n) => !before.has(n.id) && /^https?:\/\//.test(n.content))?.id ?? '';
        return id;
      },
      { timeout: 5 * 60_000, intervals: [2_000] },
    )
    .not.toBe('');
  await moveNode(id, { x: sources.size * 450, y: 0 });
  return id;
}

/**
 * A stored URL as ffprobe reads it.
 * @param url - The URL.
 * @returns Its container, length and audio stream.
 */
function probe(url: string): { format: string; duration: number; codec: string; channels: number } {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', url], { encoding: 'utf8' }),
  ) as {
    streams: { codec_type: string; codec_name: string; channels?: number }[];
    format: { format_name: string; duration?: string };
  };
  const audio = out.streams.find((s) => s.codec_type === 'audio')!;
  return {
    format: out.format.format_name,
    duration: Number(out.format.duration),
    codec: audio.codec_name,
    channels: audio.channels ?? 0,
  };
}

const RUNS: Run[] = [
  { tool: 'audio.denoise', source: 'speech.mp3' },
  {
    tool: 'audio.normalize',
    source: 'music.wav',
    set: () => page.getByTestId('mini-tool-param-target--23').click(),
  },
  { tool: 'audio.speed', source: 'music.wav', set: () => nudge('mini-tool-param-rate-slider', 'ArrowRight', 2) },
  // Two seconds off the start: PageUp moves the start by ten steps of 0.1 s.
  { tool: 'audio.cut', source: 'music.wav', set: () => nudge('mini-tool-range', 'PageUp', 2) },
  { tool: 'audio.eq', source: 'music.wav', set: () => page.getByTestId('mini-tool-eq-preset-bass_boost').click() },
  { tool: 'audio.compress', source: 'music.wav', set: () => page.getByTestId('mini-tool-dynamics-preset-heavy').click() },
  { tool: 'audio.pan', source: 'music.wav', set: () => nudge('mini-tool-param-width-slider', 'End') },
  {
    tool: 'audio.reverb',
    source: 'speech.mp3',
    set: () => page.getByTestId('mini-tool-param-room-cathedral').click(),
  },
  { tool: 'audio.voice', source: 'speech.mp3' },
  { tool: 'audio.pitch', source: 'music.wav', set: () => nudge('mini-tool-param-semitones-slider', 'ArrowRight', 3) },
  { tool: 'audio.enhance', source: 'speech.mp3' },
];

// Measured on the image the container runs (2026-10-21): each container op
// finishes in seconds on these sources; the model's run takes about a minute.
const RUN_MS = 15 * 60_000;

test.describe('real runs', () => {
  test.use({ actionTimeout: 20_000 });

  test.beforeAll(async ({ browser }) => {
    MEDIA = mkdtempSync(join(tmpdir(), 'mini-tools-batch-5-'));
    // Every file carries a mark of this run, so its bytes are ones the studio
    // has not stored before (see canvas-mini-tools-real-run.spec.ts).
    const mark = ['-metadata', `comment=mini-tools-batch-5 ${String(Date.now())}`];
    const ffmpeg = (...args: string[]): void => {
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    };
    ffmpeg('-i', join(FIXTURES, 'speech.mp3'), '-c', 'copy', ...mark, join(MEDIA, 'speech.mp3'));
    // Eight seconds of stereo at 44.1 kHz: a different tone on each side.
    ffmpeg(
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8:sample_rate=44100',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8:sample_rate=44100',
      '-filter_complex', '[0][1]amerge=inputs=2,volume=0.5', ...mark, join(MEDIA, 'music.wav'),
    );
    page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
    await openSmokeProject(page);
    projectId = smokeProjectId();
    spaceId = await createSpace(page, 'canvas', `mini-tools-batch-5-real-${String(process.pid)}`);
  });

  test.afterAll(async () => {
    if (spaceId !== '') await deleteSpace(page, spaceId);
    if (MEDIA !== '') rmSync(MEDIA, { recursive: true, force: true });
    await page?.close();
  });

  test('every audio tool runs to a new audio node that holds what its name says @needs-model @needs-ingest @needs-ffmpeg @needs-internet', async () => {
    test.setTimeout(RUN_MS + 10 * 60_000);
    for (const file of ['speech.mp3', 'music.wav'] as const) sources.set(file, await upload(file));
    await page.getByRole('button', { name: 'Fit to viewport' }).click();

    for (const run of RUNS) {
      const source = sources.get(run.source)!;
      await expect(nodeOf(source)).toBeVisible();
      await openTool(page, source, run.tool);
      await expect(page.getByTestId('mini-tool-panel-title')).toBeVisible();
      await run.set?.();
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
        .toBe(1);
      results.set(run.tool, made[0]!);
      // Results open beside their source; they are read from the document,
      // so they move off below, out of the way of the next menu.
      await moveNode(made[0]!, { x: results.size * 450, y: 3000 });
      await page.keyboard.press('Escape');
    }

    await expect
      .poll(
        async () => {
          const nodes = new Map((await documentNodes()).map((n) => [n.id, n.content]));
          return [...results].filter(([, id]) => !/^https?:\/\//.test(nodes.get(id) ?? '')).map(([tool]) => tool);
        },
        { timeout: RUN_MS, intervals: [10_000] },
      )
      .toEqual([]);

    const nodes = new Map((await documentNodes()).map((n) => [n.id, n.content]));
    const read = (tool: string): ReturnType<typeof probe> => probe(nodes.get(results.get(tool)!)!);
    for (const run of RUNS.filter((r) => r.tool !== 'audio.enhance')) {
      const out = read(run.tool);
      expect(out.format, run.tool).toContain('mp4');
      expect(out.codec, run.tool).toBe('aac');
    }
    expect(read('audio.enhance').codec).toMatch(/^pcm_/);
    expect(read('audio.speed').duration).toBeCloseTo(8 / 1.5, 0);
    expect(read('audio.cut').duration).toBeCloseTo(6, 0);
    expect(read('audio.pitch').duration).toBeCloseTo(8, 0);
    expect(read('audio.pan').channels).toBe(2);
    // A mono source stays mono, its tail added.
    expect(read('audio.reverb').channels).toBe(1);
    expect(read('audio.reverb').duration).toBeGreaterThan(6.144);
  });
});
