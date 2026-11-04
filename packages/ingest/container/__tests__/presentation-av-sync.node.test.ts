// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D3c: picture and sound of an edited source stay where the plan presents them (inner#1306 test plan §91 D3c;
 * frames-split design §4.2 audio, §7.17 timeline row 「视频与音频都按originMapping的剪辑片段处理」, §5.3 model-input row).
 *
 * The source is cut by stream copy, so its MP4 carries an edit list on each track and presentation time 0 is not media
 * time 0. A white frame and a 1 kHz tone burst are written at the same original instant. The container's own probe plans
 * the source; the recipe is built from that plan the way the worker builds it (one rate-1 span over the whole display,
 * the whole interval's audio). The expected presentation time of the picture marker is its media time (read with the edit
 * list ignored) mapped through the plan's video spans: presentationStart + (media - sourceStart) / rate. The plan does not
 * record the audio edit (the probe writes `audioSpans: null`, §91 D3b-10), so the sound marker's expected time is where the
 * source's own audio edit list puts it, as FFmpeg reads it with the edit list applied (movie time, whose 0 is presentation 0
 * here: the plan's origin is 0). The picture marker must land on its frame; the sound marker within one AAC frame.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runOwner from '@ingest/container/presentation-run.js';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { presentationFrameCount } from '@shared/mini-tools/video-presentation-table.js';

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
type Span = { sourceStart: Exact; sourceEnd: Exact; presentationStart: Exact; rate: Exact };
interface Plan {
  display: { width: number; height: number; duration: Exact };
  presentation: { schemaVersion: 1; timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
  originMapping: { timeBase: Exact; entries: { kind: string; start?: number }[] };
  videoSpans: Span[] | null; audioSpans: Span[] | null;
}

const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000 } },
  copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const PROBE_LIMITS = {
  maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536,
  sourceLedger: { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 },
};
const PROBE = { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }] };
const JOB_LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const SOURCE = '10000000-0000-4000-8000-000000000001';
const CHUNK = '10000000-0000-4000-8000-0000000000c0';
const AAC_FRAME = 1024 / 48000;

let dir: string;
let cut: string;
let plan: Plan;
const served = new Map<string, string>();
const written = new Map<string, Uint8Array>();
let reports: { ok: boolean }[] = [];

const value = (time: Exact): number => Number(time.numerator) / Number(time.denominator);
const r = (seconds: number, denominator: number): Exact => {
  const numerator = Math.round(seconds * denominator);
  const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));
  const d = gcd(numerator, denominator) || 1;
  return { numerator: String(numerator / d), denominator: String(denominator / d) };
};

/**
 * A media time mapped through a track's spans to presentation time.
 * @param spans - The plan's spans of the track.
 * @param media - The media time.
 * @returns The presentation time.
 */
function present(spans: Span[], media: number): number {
  const covering = spans.find(item => media >= value(item.sourceStart) && media < value(item.sourceEnd))!;
  expect(covering, 'a span covers the marker').toBeDefined();
  return value(covering.presentationStart) + (media - value(covering.sourceStart)) / value(covering.rate);
}

/**
 * Run one planned job and return its written output, requiring success.
 * @param inputs - Input id to file.
 * @param recipe - The output's recipe.
 * @returns The output file.
 */
async function produce(inputs: Record<string, string>, recipe: Record<string, unknown>): Promise<string> {
  const tag = Math.random().toString(36).slice(2);
  const bound = Object.entries(inputs).map(([inputId, path]) => { const url = `http://inputs.test/${tag}/${inputId}`; served.set(url, path); return { inputId, url }; });
  const url = `http://outputs.test/${tag}`;
  reports = [];
  await runPlanJob({ schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: JOB_LIMITS, inputs: bound,
    outputs: [{ outputIndex: 0, key: `video/cut.mp4.${tag}`, url, contentType: 'video/mp4', recipe }], reportUrl: 'http://jobs.test/report' } as unknown as PlanRunBody);
  expect(reports[0]?.ok).toBe(true);
  const path = join(dir, `${tag}.mp4`);
  await writeFile(path, written.get(url)!);
  return path;
}

/**
 * The presentation time of the first bright video frame.
 * @param path - The file.
 * @param ignoreEditList - Read the media timeline instead.
 * @returns Its time in seconds.
 */
async function flashAt(path: string, ignoreEditList = false): Promise<number> {
  const edit = ignoreEditList ? ['-ignore_editlist', '1'] : [];
  const { stdout: times } = await run('ffprobe', ['-v', 'error', ...edit, '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path]);
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...edit, '-i', path, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', 'extractplanes=y,scale=1:1:flags=area', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const levels = [...(stdout as unknown as Buffer)];
  const pts = times.trim().split('\n').map(Number);
  const index = levels.findIndex(level => level > 128);
  expect(index, 'a bright frame').toBeGreaterThanOrEqual(0);
  return pts[index]!;
}

/**
 * The time of the tone burst's onset: the first sample above a third of full scale.
 * @param path - The file.
 * @param ignoreEditList - Read the media timeline instead.
 * @returns Its time in seconds.
 */
async function toneAt(path: string, ignoreEditList = false): Promise<number> {
  const edit = ignoreEditList ? ['-ignore_editlist', '1'] : [];
  const { stdout: first } = await run('ffprobe', ['-v', 'error', ...edit, '-select_streams', 'a:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+#1', path]);
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...edit, '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const samples = new Int16Array(new Uint8Array(stdout).buffer.slice(0));
  const index = samples.findIndex(sample => Math.abs(sample) > 10000);
  expect(index, 'a tone burst').toBeGreaterThanOrEqual(0);
  // With the edit list applied, decoded samples start at presentation 0; ignoring it, at the first packet's media time.
  return (ignoreEditList ? Number(first.trim().split('\n')[0]!.replace(',', '')) : 0) + index / 48000;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'presentation-av-sync-'));
  const ff = async (name: string, args: string[]): Promise<void> => { await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, join(dir, name)]); };
  // One white frame (frame 25, original 1.0 s) and a 1 kHz burst over [1.0, 1.1) s, on otherwise black and silent tracks.
  await ff('base.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=25:d=2,format=yuv420p,geq=lum='if(eq(N\\,25)\\,235\\,16)':cb=128:cr=128",
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t\\,1.0\\,1.1)\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=2",
    '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-c:a', 'aac', '-shortest']);
  // A stream-copy cut: packets start at the 0.4 s keyframe and each track's edit starts later (design §4.1 row 2, D1 CT04).
  await ff('cut.mp4', ['-ss', '0.5', '-i', join(dir, 'base.mp4'), '-c', 'copy']);
  cut = join(dir, 'cut.mp4');
  const bytes = await readFile(cut);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'content-length': String(bytes.byteLength), 'content-type': 'video/mp4' } })));
  const planned = await (runOwner as unknown as Record<string, (body: unknown) => Promise<{ kind: string; plan: Plan }>>).runPresentationProbe!({ action: 'probe',
    jobId: 'video-presentation:av', sourceFingerprint: createHash('sha256').update(bytes).digest('hex'), deadlineAt: Date.now() + 3_600_000,
    sourceURL: 'http://source.test/cut.mp4', limits: PROBE_LIMITS, encoding: ENCODING, probe: PROBE });
  vi.unstubAllGlobals();
  expect(planned.kind).toBe('planned');
  plan = planned.plan;
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  written.clear();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') { written.set(url, new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(null, { status: 200 }); }
    if (init?.method === 'POST') { reports.push(JSON.parse(String(init.body)) as { ok: boolean }); return new Response(null, { status: 200 }); }
    const path = served.get(url);
    if (path === undefined) return new Response(null, { status: 404 });
    const bytes = await readFile(path);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

/**
 * The recipe fields the worker writes for the whole display: one rate-1 span from the plan, the plan target and audio.
 * @returns The fields.
 */
function whole(): Record<string, unknown> {
  const scale = plan.presentation.timescale;
  const [span] = plan.videoSpans!;
  const entry = plan.originMapping.entries[0]!;
  const decodeStart = r(entry.start! * value(plan.originMapping.timeBase), 12800);
  return {
    inputId: SOURCE, window: { start: 0, end: presentationFrameCount(plan.presentation) }, timescale: scale,
    entries: [{ kind: 'source', decodeStart, clipStart: span!.sourceStart, displayStart: { numerator: '0', denominator: '1' }, displayEnd: plan.display.duration, rate: { numerator: '1', denominator: '1' } }],
    target: { width: plan.display.width, height: plan.display.height, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' },
  };
}

describe('an edited source keeps picture and sound at their plan times (§4.2, §7.17 timeline row)', () => {
  it('AV00 the source is edited: presentation 0 is not media 0, and the plan starts at movie time 0', async () => {
    expect(plan.videoSpans).not.toBeNull();
    expect(value(plan.videoSpans![0]!.sourceStart)).toBeGreaterThan(0);
    expect(value(plan.videoSpans![0]!.presentationStart)).toBe(0);
    expect(await toneAt(cut, true)).toBeGreaterThan(await toneAt(cut) + 0.05);
  });

  /**
   * Chunk then stitch the whole display of the cut source.
   * @returns The stitched carrier.
   */
  async function stitched(): Promise<string> {
    const fields = whole();
    const chunk = await produce({ [SOURCE]: cut }, { kind: 'chunk_encode', ...fields });
    return produce({ [SOURCE]: cut, [CHUNK]: chunk }, { kind: 'stitch', inputId: SOURCE, chunks: [{ inputId: CHUNK, duration: plan.display.duration }],
      audio: { start: { numerator: '0', denominator: '1' }, end: plan.display.duration }, target: fields.target });
  }

  /**
   * Prepare the model input over the whole display of the cut source.
   * @returns The model input.
   */
  function modelInput(): Promise<string> {
    return produce({ [SOURCE]: cut }, { kind: 'prepare_model_input', ...whole(), audio: { start: { numerator: '0', denominator: '1' }, end: plan.display.duration } });
  }

  it.each([['chunk then stitch', stitched], ['prepare_model_input', modelInput]] as const)('AV01 %s: the white frame lands on its plan time', async (_name, render) => {
    const expected = present(plan.videoSpans!, await flashAt(cut, true));
    expect(Math.abs(await flashAt(await render()) - expected)).toBeLessThan(0.5 / plan.presentation.timescale);
  });

  it.each([['chunk then stitch', stitched], ['prepare_model_input', modelInput]] as const)('AV02 %s: the tone burst lands where the source\'s audio edit puts it, within one AAC frame', async (_name, render) => {
    const expected = await toneAt(cut);
    expect(Math.abs(await toneAt(await render()) - expected)).toBeLessThanOrEqual(AAC_FRAME);
  });
});
