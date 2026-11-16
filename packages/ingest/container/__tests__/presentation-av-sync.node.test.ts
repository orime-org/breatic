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
  originMapping: { timeBase: Exact; origin: Exact; entries: { kind: string; start?: number }[] };
  videoSpans: Span[] | null; audioSpans: Span[] | null;
}

const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
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
let lead: string;
let leadPlan: Plan;
let lag: string;
let lagPlan: Plan;
let noedit: string;
let noeditPlan: Plan;
// Matroska sources whose audio encoder primes before time 0, by codec, with their plans.
const PRIMED = ['aac', 'libmp3lame', 'ac3'] as const;
const primed = new Map<string, [string, Plan]>();
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
  // -copyts keeps each sample on its track time (movie time, or media time with the edit list ignored); aresample with
  // first_pts=0 lays the samples out from time 0, so a track that starts late is padded and the index is the time.
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...edit, '-copyts', '-i', path, '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const samples = new Int16Array(new Uint8Array(stdout).buffer.slice(0));
  const index = samples.findIndex(sample => Math.abs(sample) > 10000);
  expect(index, 'a tone burst').toBeGreaterThanOrEqual(0);
  return index / 48000;
}

/** One ISO track's facts: handler, media timescale and edit list (segment duration, media time, 16.16 rate). */
interface IsoTrack { handler: string; timescale: number; edits: [number, number, number][] }

/**
 * Read the movie timescale and every track's edit list straight from the MP4 boxes, independently of the probe.
 * @param path - The file.
 * @returns The movie timescale and the tracks.
 */
async function isoTracks(path: string): Promise<{ movie: number; tracks: IsoTrack[] }> {
  const b = await readFile(path);
  const boxes = function* (start: number, end: number): Generator<[string, number, number]> {
    let at = start;
    while (at + 8 <= end) {
      let size = b.readUInt32BE(at);
      let header = 8;
      if (size === 1) { size = Number(b.readBigUInt64BE(at + 8)); header = 16; }
      if (size === 0) size = end - at;
      yield [b.toString('latin1', at + 4, at + 8), at + header, at + size];
      at += size;
    }
  };
  let movie = 0;
  const tracks: IsoTrack[] = [];
  for (const [type, start, end] of boxes(0, b.length)) {
    if (type !== 'moov') continue;
    for (const [inner, s2, e2] of boxes(start, end)) {
      if (inner === 'mvhd') movie = b.readUInt32BE(s2 + (b[s2] === 1 ? 20 : 12));
      if (inner !== 'trak') continue;
      const track: IsoTrack = { handler: '', timescale: 0, edits: [] };
      for (const [part, s3, e3] of boxes(s2, e2)) {
        if (part === 'edts') {
          for (const [, s4] of boxes(s3, e3)) {
            const wide = b[s4] === 1;
            let cursor = s4 + 8;
            for (let n = b.readUInt32BE(s4 + 4); n > 0; n -= 1) {
              const duration = wide ? Number(b.readBigUInt64BE(cursor)) : b.readUInt32BE(cursor);
              const media = wide ? Number(b.readBigInt64BE(cursor + 8)) : b.readInt32BE(cursor + 4);
              cursor += wide ? 16 : 8;
              track.edits.push([duration, media, b.readInt32BE(cursor)]);
              cursor += 4;
            }
          }
        }
        if (part === 'mdia') {
          for (const [leaf, s4] of boxes(s3, e3)) {
            if (leaf === 'mdhd') track.timescale = b.readUInt32BE(s4 + (b[s4] === 1 ? 20 : 12));
            if (leaf === 'hdlr') track.handler = b.toString('latin1', s4 + 8, s4 + 12);
          }
        }
      }
      tracks.push(track);
    }
  }
  return { movie, tracks };
}

/**
 * The audio track's edit list as plan spans, by the rule the video spans follow (design §3.5 full row 「音视频spans」):
 * each non-empty edit presents media [m, m + d·rate) from its movie time, rebased by the plan's origin.
 * @param path - The file.
 * @param origin - The plan's origin in seconds.
 * @returns The spans as seconds.
 */
async function audioEditSpans(path: string, origin: number): Promise<{ sourceStart: number; sourceEnd: number; presentationStart: number; rate: number }[]> {
  const { movie, tracks } = await isoTracks(path);
  const track = tracks.find(item => item.handler === 'soun')!;
  const spans: { sourceStart: number; sourceEnd: number; presentationStart: number; rate: number }[] = [];
  let at = 0;
  for (const [duration, media, rate] of track.edits) {
    if (media !== -1 && duration > 0) spans.push({ sourceStart: media / track.timescale, sourceEnd: media / track.timescale + (duration / movie) * (rate / 65536), presentationStart: at / movie - origin, rate: rate / 65536 });
    at += duration;
  }
  return spans;
}

/**
 * The container's own plan of a source.
 * @param path - The source.
 * @returns The plan.
 */
async function planOf(path: string): Promise<Plan> {
  const bytes = await readFile(path);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { headers: { 'content-length': String(bytes.byteLength), 'content-type': 'video/mp4' } })));
  const planned = await (runOwner as unknown as Record<string, (body: unknown) => Promise<{ kind: string; plan: Plan }>>).runPresentationProbe!({ action: 'probe',
    jobId: 'video-presentation:av', sourceFingerprint: createHash('sha256').update(bytes).digest('hex'), deadlineAt: Date.now() + 3_600_000,
    sourceURL: 'http://source.test/av.mp4', limits: PROBE_LIMITS, encoding: ENCODING, probe: PROBE });
  vi.unstubAllGlobals();
  expect(planned.kind).toBe('planned');
  return planned.plan;
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
  // §91 D3b-10: a 250 ms leading empty edit on both tracks (the audio's starting earlier than the picture's): origin is not 0.
  await ff('lead.mp4', ['-itsoffset', '0.25', '-i', join(dir, 'base.mp4'), '-c', 'copy', '-use_editlist', '1']);
  lead = join(dir, 'lead.mp4');
  // The picture's edit starts at 0.25 s and the sound's at 0.5 s: presentation starts on the first frame (origin 1/4, no
  // earlier audio, design §4.2.1 开头行) and the sound starts later than presentation 0.
  await ff('lag.mp4', ['-itsoffset', '0.25', '-i', join(dir, 'base.mp4'), '-itsoffset', '0.5', '-i', join(dir, 'base.mp4'), '-map', '0:v', '-map', '1:a', '-c', 'copy', '-use_editlist', '1']);
  lag = join(dir, 'lag.mp4');
  // The same tracks with no edit list at all (§91 D3b mutation C7): media time is movie time on both.
  await ff('noedit.mp4', ['-i', join(dir, 'base.mp4'), '-c', 'copy', '-use_editlist', '0']);
  noedit = join(dir, 'noedit.mp4');
  plan = await planOf(cut);
  leadPlan = await planOf(lead);
  lagPlan = await planOf(lag);
  noeditPlan = await planOf(noedit);
  for (const codec of PRIMED) {
    await ff(`primed-${codec}.mkv`, ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=25:d=2,format=yuv420p,geq=lum='if(eq(N\\,25)\\,235\\,16)':cb=128:cr=128",
      '-f', 'lavfi', '-i', "aevalsrc='if(between(t\\,1.0\\,1.1)\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=2",
      '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-c:a', codec, '-shortest']);
    primed.set(codec, [join(dir, `primed-${codec}.mkv`), await planOf(join(dir, `primed-${codec}.mkv`))]);
  }
}, 120_000);
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
function whole(of: Plan = plan): Record<string, unknown> {
  const scale = of.presentation.timescale;
  const entry = of.originMapping.entries[0]!;
  const decodeStart = r(entry.start! * value(of.originMapping.timeBase), 12800);
  const clipStart = of.videoSpans === null ? decodeStart : of.videoSpans[0]!.sourceStart;
  return {
    inputId: SOURCE, window: { start: 0, end: presentationFrameCount(of.presentation) }, timescale: scale,
    entries: [{ kind: 'source', decodeStart, clipStart, displayStart: { numerator: '0', denominator: '1' }, displayEnd: of.display.duration, rate: { numerator: '1', denominator: '1' } }],
    target: { width: of.display.width, height: of.display.height, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' },
  };
}

/**
 * The recipe's audio (§91 D3b-11): the whole display interval in presentation time, the plan's origin and the plan's audio
 * spans; with spans the container places media time by them, without (no audio edit) presentation = movie time - origin.
 * @param of - The plan.
 * @param spans - The audio spans to send.
 * @returns The audio field.
 */
function audioOf(of: Plan, spans: Span[] | null): Record<string, unknown> {
  return { start: { numerator: '0', denominator: '1' }, end: of.display.duration, origin: of.originMapping.origin, spans };
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
  async function stitched(source = cut, of = plan, spans: Span[] | null = of.audioSpans): Promise<string> {
    const fields = whole(of);
    const chunk = await produce({ [SOURCE]: source }, { kind: 'chunk_encode', ...fields });
    return produce({ [SOURCE]: source, [CHUNK]: chunk }, { kind: 'stitch', inputId: SOURCE, chunks: [{ inputId: CHUNK, duration: of.display.duration }],
      audio: audioOf(of, spans), target: fields.target });
  }

  /**
   * Prepare the model input over the whole display of the cut source.
   * @returns The model input.
   */
  function modelInput(source = cut, of = plan, spans: Span[] | null = of.audioSpans): Promise<string> {
    return produce({ [SOURCE]: source }, { kind: 'prepare_model_input', ...whole(of), audio: audioOf(of, spans) });
  }

  it.each([['chunk then stitch', (): Promise<string> => stitched()], ['prepare_model_input', (): Promise<string> => modelInput()]] as const)('AV01 %s: the white frame lands on its plan time', async (_name, render) => {
    const expected = present(plan.videoSpans!, await flashAt(cut, true));
    expect(Math.abs(await flashAt(await render()) - expected)).toBeLessThan(0.5 / plan.presentation.timescale);
  });

  it.each([['chunk then stitch', (): Promise<string> => stitched()], ['prepare_model_input', (): Promise<string> => modelInput()]] as const)('AV02 %s: the tone burst lands where the source\'s audio edit puts it, within one AAC frame', async (_name, render) => {
    const expected = await toneAt(cut);
    expect(Math.abs(await toneAt(await render()) - expected)).toBeLessThanOrEqual(AAC_FRAME);
  });

  // §91 D3b-10 (design §3.5 full row 「full包含§3.1的originMapping及音视频spans」, §7.17 timeline row): the plan records the
  // audio track's edits the way it records the video's, rebased by the same origin.
  it.each([['the cut source (origin 0)', (): [string, Plan] => [cut, plan]], ['the leading-empty-edit source', (): [string, Plan] => [lead, leadPlan]], ['the late-sound source', (): [string, Plan] => [lag, lagPlan]]] as const)('AS01 the plan of %s records the audio edit list as audioSpans', async (_name, which) => {
    const [source, of] = which();
    const expected = await audioEditSpans(source, value(of.originMapping.origin));
    expect(expected.length).toBeGreaterThan(0);
    expect(of.audioSpans).not.toBeNull();
    expect(of.audioSpans!.map(span => ({ sourceStart: value(span.sourceStart), sourceEnd: value(span.sourceEnd), presentationStart: value(span.presentationStart), rate: value(span.rate) })))
      .toEqual(expected.map(span => ({ sourceStart: expect.closeTo(span.sourceStart, 9), sourceEnd: expect.closeTo(span.sourceEnd, 9), presentationStart: expect.closeTo(span.presentationStart, 9), rate: span.rate })));
  });

  it('AS02 both offset sources are presented from a later movie time: origin is not 0 (the late-sound source from its first frame, 1/4)', () => {
    expect(value(leadPlan.originMapping.origin)).toBeGreaterThan(0);
    expect(value(lagPlan.originMapping.origin)).toBe(0.25);
  });

  // Presentation time is movie time less the origin. Where the sound starts at the origin (the derived-lead source) the
  // first sample is presentation 0; where it starts later (the late-sound source) it must keep its gap.
  it.each([
    ['chunk then stitch of the derived-lead source', (): [string, Plan] => [lead, leadPlan], true],
    ['prepare_model_input of the derived-lead source', (): [string, Plan] => [lead, leadPlan], false],
    ['chunk then stitch of the late-sound source', (): [string, Plan] => [lag, lagPlan], true],
    ['prepare_model_input of the late-sound source', (): [string, Plan] => [lag, lagPlan], false],
  ] as const)('AV03 %s: the tone burst lands at its plan presentation time', async (_name, which, stitch) => {
    const [source, of] = which();
    const render = (): Promise<string> => (stitch ? stitched(source, of) : modelInput(source, of));
    const expected = await toneAt(source) - value(of.originMapping.origin);
    expect(Math.abs(await toneAt(await render()) - expected)).toBeLessThanOrEqual(AAC_FRAME);
  });

  // The same late-sound source with the audio spans the plan must record (AS01), read from its edit list: the container
  // places the media samples by them.
  it.each([['chunk then stitch', true], ['prepare_model_input', false]] as const)('AV04 %s of the late-sound source with its audio spans: the tone burst lands at its plan presentation time', async (_name, stitch) => {
    const spans = (await audioEditSpans(lag, value(lagPlan.originMapping.origin))).map(span => ({
      sourceStart: r(span.sourceStart, 48000), sourceEnd: r(span.sourceEnd, 48000), presentationStart: r(span.presentationStart, 1000), rate: r(span.rate, 1) }));
    const output = stitch ? await stitched(lag, lagPlan, spans) : await modelInput(lag, lagPlan, spans);
    expect(Math.abs(await toneAt(output) - (await toneAt(lag) - value(lagPlan.originMapping.origin)))).toBeLessThanOrEqual(AAC_FRAME);
  });

  /**
   * Where an output's sound starts: the stream's start with the edit list applied, and its first packet's time without it.
   * @param path - The output.
   * @returns Both, in seconds.
   */
  async function soundStart(path: string): Promise<{ start: number; firstPacket: number }> {
    const { stdout: start } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', path]);
    const { stdout: first } = await run('ffprobe', ['-v', 'error', '-ignore_editlist', '1', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+#1', path]);
    return { start: Number(start.trim()), firstPacket: Number(first.trim().split('\n')[0]!.replace(',', '')) };
  }

  // §91 D3b mutation C4 (D3b-11 「保留音频起点之前的静音」): the silence before the late sound is real samples from 0, not an
  // offset an edit list carries, so a player or model reading the file without edit lists keeps the sync.
  it.each([['chunk then stitch', true], ['prepare_model_input', false]] as const)('AV05 %s of the late-sound source: the sound track starts at 0 with decoded silence before the burst', async (_name, stitch) => {
    const output = stitch ? await stitched(lag, lagPlan) : await modelInput(lag, lagPlan);
    expect(await soundStart(output)).toEqual({ start: 0, firstPacket: 0 });
    const tone = await toneAt(output);
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-ignore_editlist', '1', '-i', output, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
    const samples = new Int16Array(new Uint8Array(stdout).buffer.slice(0));
    expect(samples.length / 48000).toBeGreaterThan(tone);
    expect(Math.max(...samples.subarray(0, Math.floor((tone - 0.05) * 48000)).map(Math.abs))).toBeLessThan(200);
  });

  // §91 D3b mutation C7 (D3b-11, spans null: presentation = movie time - origin). A probed plan gives origin 0 for a sound
  // track without edits (it starts at movie 0), so the recipe here names an origin by hand to pin the wire rule.
  it.each([['chunk then stitch', true], ['prepare_model_input', false]] as const)('AV06 %s with no audio edit list and an origin of 1/4: the tone burst lands at movie time less the origin', async (_name, stitch) => {
    const of = { ...noeditPlan, originMapping: { ...noeditPlan.originMapping, origin: { numerator: '1', denominator: '4' } } };
    const output = stitch ? await stitched(noedit, of, null) : await modelInput(noedit, of, null);
    expect(Math.abs(await toneAt(output) - (await toneAt(noedit) - 0.25))).toBeLessThanOrEqual(AAC_FRAME);
  });

  // §4.2 effective audio: FFmpeg's Matroska muxer stores the encoder priming of AAC, MP3 and AC3 as samples before time 0
  // (CodecDelay only for Opus); like an MP4 edit list's skipped priming, they are not presented.
  it.each(PRIMED)('AV07 a Matroska source whose %s priming starts before 0 plans, its burst on its white frame', async (codec) => {
    const [mkv, of] = primed.get(codec)!;
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_pts', '-of', 'csv=p=0', mkv]);
    expect(Number(stdout.trim())).toBeLessThan(0);
    expect(value(of.originMapping.origin)).toBe(0);
    const output = await stitched(mkv, of, null);
    expect(Math.abs(await toneAt(output) - await flashAt(output))).toBeLessThanOrEqual(AAC_FRAME);
  });
});

// S6d D4 (inner#1306 §91 D4; design §4.2 变速音频 rational-relabel, §7.17 timeline row): spans at a rate other than 1 and
// several audio spans. The recipes are written by hand from the edit they describe, on the media timeline of base.mp4
// (no edit on its video; its audio's only edit skips the AAC priming), so they do not depend on the probe. Every span
// starts on frame 0, a keyframe, so the decodeStart choice still open (§91 W7) does not change them.
describe('spans at a rate other than 1 and several audio spans (§91 D4; design §4.2, §7.17)', () => {
  const base = (): string => join(dir, 'base.mp4');
  const q = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
  const target = { width: 160, height: 96, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };

  /**
   * A model input over a rate-1 video of the whole 2 s source, with the given audio spans.
   * @param spans - Audio spans on the media timeline.
   * @returns The output.
   */
  function withAudio(spans: Span[]): Promise<string> {
    return produce({ [SOURCE]: base() }, { kind: 'prepare_model_input', inputId: SOURCE, window: { start: 0, end: 50 }, timescale: 25,
      entries: [{ kind: 'source', decodeStart: q(0), clipStart: q(0), displayStart: q(0), displayEnd: q(2), rate: q(1) }], target,
      audio: { start: q(0), end: q(2), origin: q(0), spans } });
  }

  it('DR01 a video span at rate 2 presents every source frame for half its time: 50 frames over 1 s, the white frame at 0.5 s', async () => {
    const output = await produce({ [SOURCE]: base() }, { kind: 'chunk_encode', inputId: SOURCE, window: { start: 0, end: 50 }, timescale: 50,
      entries: [{ kind: 'source', decodeStart: q(0), clipStart: q(0), displayStart: q(0), displayEnd: q(1), rate: q(2) }], target });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', output]);
    expect(stdout.trim().split('\n').map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_unused, n) => n / 50));
    expect(await flashAt(output)).toBeCloseTo(0.5, 6);
  });

  it('DR02 an audio span at rate 2 (rational relabel) puts the tone burst at half its media time', async () => {
    const media = await toneAt(base(), true);
    const spans = [{ sourceStart: q(0), sourceEnd: q(2), presentationStart: q(0), rate: q(2) }];
    expect(Math.abs(await toneAt(await withAudio(spans)) - media / 2)).toBeLessThanOrEqual(AAC_FRAME);
  });

  it('DR03 two rate-1 audio spans are laid end to end: the burst in the second span lands at its presentation time', async () => {
    const media = await toneAt(base(), true);
    const spans = [
      { sourceStart: q(0), sourceEnd: q(1, 2), presentationStart: q(0), rate: q(1) },
      { sourceStart: q(9, 10), sourceEnd: q(7, 5), presentationStart: q(1, 2), rate: q(1) },
    ];
    expect(Math.abs(await toneAt(await withAudio(spans)) - (0.5 + media - 0.9))).toBeLessThanOrEqual(AAC_FRAME);
  });

  it('DR04 an audio span at rate 1/2 doubles the time from its start to the burst', async () => {
    const media = await toneAt(base(), true);
    const spans = [{ sourceStart: q(3, 5), sourceEnd: q(7, 5), presentationStart: q(0), rate: q(1, 2) }];
    expect(Math.abs(await toneAt(await withAudio(spans)) - (media - 0.6) * 2)).toBeLessThanOrEqual(AAC_FRAME);
  });
});

/**
 * Rewrite every non-empty edit of every track to play at `rate`: the 16.16 rate field and the segment duration (movie time
 * shrinks by the rate), leaving the media untouched (§91 D4-1: a hand-patched edit list).
 * @param from - The source file.
 * @param to - The patched file.
 * @param rate - The rate as numerator and denominator.
 * @returns Nothing once written.
 */
async function patchEditRate(from: string, to: string, rate: [number, number]): Promise<void> {
  const b = Buffer.from(await readFile(from));
  const walk = (start: number, end: number): void => {
    let at = start;
    while (at + 8 <= end) {
      const size = b.readUInt32BE(at);
      const type = b.toString('latin1', at + 4, at + 8);
      if (['moov', 'trak', 'edts'].includes(type)) walk(at + 8, at + size);
      if (type === 'elst') {
        const wide = b[at + 8] === 1;
        let cursor = at + 16;
        for (let n = b.readUInt32BE(at + 12); n > 0; n -= 1) {
          const media = wide ? Number(b.readBigInt64BE(cursor + 8)) : b.readInt32BE(cursor + 4);
          if (media !== -1) {
            const duration = wide ? Number(b.readBigUInt64BE(cursor)) : b.readUInt32BE(cursor);
            const scaled = Math.round((duration * rate[1]) / rate[0]);
            if (wide) b.writeBigUInt64BE(BigInt(scaled), cursor); else b.writeUInt32BE(scaled, cursor);
            b.writeInt32BE(Math.round((rate[0] / rate[1]) * 65536), cursor + (wide ? 16 : 8));
          }
          cursor += wide ? 20 : 12;
        }
      }
      at += size;
    }
  };
  walk(0, b.length);
  await writeFile(to, b);
}

// S6d D4-1 (design §3 line 172 「非 1 正速率…按声明…处理」, line 205; §91 D4-1 answer): a positive edit rate other than 1 is
// processed by its declaration, in QuickTime and ISO files alike. The fixtures patch base's edit lists (QuickTime at 2 and
// 1/2, and the isom-brand MP4 at 2, the design's diagnostic case); the plan records the rate in both tracks' spans and
// presents each frame for its media duration divided by the rate.
describe('the probe plans edits at a rate other than 1 (§91 D4-1; design §3 line 172, §4.2)', () => {
  const fixtures: Record<string, [number, number]> = { 'rate2.mov': [2, 1], 'rate-half.mov': [1, 2], 'rate2.mp4': [2, 1] };
  beforeAll(async () => {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', join(dir, 'base.mp4'), '-c', 'copy', '-f', 'mov', join(dir, 'base.mov')]);
    await patchEditRate(join(dir, 'base.mov'), join(dir, 'rate2.mov'), [2, 1]);
    await patchEditRate(join(dir, 'base.mov'), join(dir, 'rate-half.mov'), [1, 2]);
    await patchEditRate(join(dir, 'base.mp4'), join(dir, 'rate2.mp4'), [2, 1]);
  });

  it.each(Object.entries(fixtures))('DP01 %s: both tracks\' spans carry the rate and the display lasts the media duration divided by it', async (name, [numerator, denominator]) => {
    const rate = numerator / denominator;
    const of = await planOf(join(dir, name));
    expect(of.videoSpans).not.toBeNull();
    expect(of.videoSpans!.map(span => value(span.rate))).toEqual([rate]);
    expect(of.audioSpans).not.toBeNull();
    expect(of.audioSpans!.map(span => value(span.rate))).toEqual([rate]);
    expect(value(of.display.duration)).toBeCloseTo(2 / rate, 6);
    // 50 frames of 1/25 s media each, presented for 1/(25·rate) s.
    expect(presentationFrameCount(of.presentation)).toBe(50);
    expect(of.presentation.runs.every(run => run.duration / of.presentation.timescale === 1 / (25 * rate))).toBe(true);
  });
});

// S6d D4-2 (design line 858: span bounds by av_rescale round-to-nearest onto the 48 kHz grid): sample-exact placement,
// measured on single-sample clicks, whose peak AAC keeps exactly (checked: a click at sample 48000 decodes peaking at 48000).
describe('audio spans land on the 48 kHz sample grid (§91 D4-2; design line 858)', () => {
  const q = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
  const target = { width: 160, height: 96, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
  let clicks: string;
  let clicks10: string;
  beforeAll(async () => {
    clicks = join(dir, 'clicks.mp4');
    // Clicks at original samples 24000, 43200 and 72000 (0.5, 0.9 and 1.5 s), on a black 2 s picture.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x96:r=25:d=2',
      '-f', 'lavfi', '-i', "aevalsrc='if(eq(n\\,24000)+eq(n\\,43200)+eq(n\\,72000)\\,0.9\\,0)':s=48000:d=2",
      '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clicks]);
    // Eleven clicks, at original sample 48000·k + 1000 (k = 0…10), over 11 s; the span below covers the first ten.
    clicks10 = join(dir, 'clicks10.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x96:r=25:d=11',
      '-f', 'lavfi', '-i', "aevalsrc='if(eq(mod(n\\,48000)\\,1000)\\,0.9\\,0)':s=48000:d=11",
      '-c:v', 'libx264', '-g', '25', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clicks10]);
  });

  /**
   * The sample indices of the clicks: peaks above half scale, one per click.
   * @param path - The file.
   * @param ignoreEditList - Read the media timeline instead.
   * @returns The indices.
   */
  async function clicksAt(path: string, ignoreEditList = false): Promise<number[]> {
    const edit = ignoreEditList ? ['-ignore_editlist', '1'] : [];
    const { stdout } = await run('ffmpeg', ['-v', 'error', ...edit, '-copyts', '-i', path, '-map', '0:a:0', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
    const samples = new Int16Array(new Uint8Array(stdout).buffer.slice(0));
    // A click relabelled to another rate and band-limited back to 48 kHz keeps its position, not its amplitude: find each
    // as a local peak against the file's own level (half its largest sample), one per 200-sample neighbourhood.
    const level = samples.reduce((top, sample) => Math.max(top, Math.abs(sample)), 0) / 2;
    const peaks: number[] = [];
    for (let at = 0; at < samples.length; at += 1) {
      if (Math.abs(samples[at]!) < level) continue;
      const last = peaks.at(-1);
      if (last !== undefined && at - last < 200) { if (Math.abs(samples[at]!) > Math.abs(samples[last]!)) peaks[peaks.length - 1] = at; continue; }
      peaks.push(at);
    }
    return peaks;
  }

  /**
   * A model input of the clicks source over [0, 2) with the given audio spans.
   * @param spans - Audio spans on the media timeline.
   * @returns The output.
   */
  function render(spans: Span[]): Promise<string> {
    return produce({ [SOURCE]: clicks }, { kind: 'prepare_model_input', inputId: SOURCE, window: { start: 0, end: 50 }, timescale: 25,
      entries: [{ kind: 'source', decodeStart: q(0), clipStart: q(0), displayStart: q(0), displayEnd: q(2), rate: q(1) }], target,
      audio: { start: q(0), end: q(2), origin: q(0), spans } });
  }

  /**
   * Where a media-time sample lands: presentationStart + (media - sourceStart) / rate, on the 48 kHz grid rounded to nearest.
   * @param media - The media sample index.
   * @param span - The span it lies in.
   * @returns The output sample index.
   */
  function landing(media: number, span: { sourceStart: number; presentationStart: number; rate: number }): number {
    return Math.round(span.presentationStart * 48000 + (media - span.sourceStart * 48000) / span.rate);
  }

  it.each([
    ['two rate-1 spans', [[0.4, 0.6, 0, 1], [0.8, 1.0, 0.2, 1]]],
    ['one span at rate 2', [[0.4, 1.6, 0, 2]]],
    ['one span at rate 1/2', [[0.8, 1.0, 0, 0.5]]],
  ] as const)('DS01 %s: each click lands on its sample, within one', async (_name, layout) => {
    const media = await clicksAt(clicks, true);
    const spans = layout.map(([from, to, at, rate]) => ({ sourceStart: q(Math.round(from * 48000), 48000), sourceEnd: q(Math.round(to * 48000), 48000),
      presentationStart: q(Math.round(at * 1000), 1000), rate: rate === 0.5 ? q(1, 2) : q(rate) }));
    const expected = media.flatMap(sample => layout.filter(([from, to]) => sample >= from * 48000 && sample < to * 48000).map(([from, , at, rate]) => landing(sample, { sourceStart: from, presentationStart: at, rate })));
    expect(expected.length).toBeGreaterThan(0);
    const landed = await clicksAt(await render(spans));
    expect(landed).toHaveLength(expected.length);
    landed.forEach((sample, index) => expect(Math.abs(sample - expected[index]!)).toBeLessThanOrEqual(1));
  });

  // The implementer's shortcut (presentation-recipes.ts `ponytail:`: a relabel whose intermediate rate would exceed 384 kHz
  // is rounded to the nearest hertz) must not move samples off the grid: at a 16.16 rate of 65535/65536 over 10 s, every
  // click still lands within one sample of presentationStart·48000 + (media - sourceStart·48000)·b/a (design line 858).
  it('DS02 a span at the 16.16 rate 65535/65536 over 10 s: each click lands on its sample, within one, to the last', async () => {
    const media = (await clicksAt(clicks10, true)).filter(sample => sample < 10 * 48000);
    expect(media).toHaveLength(10);
    const output = await produce({ [SOURCE]: clicks10 }, { kind: 'prepare_model_input', inputId: SOURCE, window: { start: 0, end: 250 }, timescale: 25,
      entries: [{ kind: 'source', decodeStart: q(0), clipStart: q(0), displayStart: q(0), displayEnd: q(10), rate: q(1) }], target,
      audio: { start: q(0), end: q(10), origin: q(0), spans: [{ sourceStart: q(0), sourceEnd: q(10), presentationStart: q(0), rate: q(65535, 65536) }] } });
    const landed = await clicksAt(output);
    const expected = media.map(sample => Math.round((sample * 65536) / 65535));
    expect(landed).toHaveLength(expected.length);
    const drift = landed.map((sample, index) => sample - expected[index]!);
    expect(drift.map(Math.abs).every(value => value <= 1), `drift per click: ${drift.join(', ')}`).toBe(true);
  });
});

