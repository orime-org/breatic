// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6a unified presentation contracts (inner#1306, test plan §87; frames-split
 * design §3.2 identities, §3.5 one strict schema per object, §7.16 compact
 * projection of the full ledger).
 *
 * toolInputId = sha256(canonical(sourceFingerprint, planSha256)) changes only
 * with the source bytes or the plan; versionId adds policy, producer/profile and
 * the carrier's actual bytes. The plan covers timing, derived-rule policy values,
 * the resolved colour matrix, the display geometry and the source transfer, bit
 * depth and output conversion they decide, never carrier choices,
 * URLs or later object hashes. Each object has one strict schema; the earlier
 * shapes (v1 descriptor and manifest, v2 ledger and receipt, the bare compact
 * table) fail to parse because there is no legacy reader. schemaVersion keeps
 * its current values (descriptor and manifest 1, full and receipt 2); the compact
 * envelope has exactly four fields. The receipt keeps producerVersion and the
 * compact receipt carries its own contentType.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as entry from '../../index.js';
import { canonicalMiniToolValue } from '../../mini-tools/canonical-value.js';
import { presentationFrameCount, projectPresentationTable, type VideoPresentationTable } from '../../mini-tools/video-presentation-table.js';

interface Rational { numerator: string; denominator: string }
interface Schema<T> { parse: (value: unknown) => T; safeParse: (value: unknown) => { success: boolean } }
interface ObjectReceipt { storageKey: string; url: string; etag: string; size: number; sha256: string; contentType: string }
type OriginEntry = { kind: 'source'; start: number; count: number; step: number } | { kind: 'derived-empty' };
interface Plan {
  display: { width: number; height: number; duration: Rational };
  colorMatrix: string;
  source: { transfer: string | null; bitDepth: number };
  output: { toneMap: 'none' | 'sdr-bt709'; framePngBitDepth: 8 | 16 };
  policy: { singleFrameDurationMs: number; emptyFill: 'black' | 'transparent' };
  presentation: VideoPresentationTable;
  originMapping: {
    timeBase: Rational;
    origin: Rational;
    entries: OriginEntry[];
    firstSource: { supportStart: Rational; lead: null | { kind: 'derived-lead'; start: Rational } };
    lastSource: { support: 'declared' | 'previous-max' | 'single-frame'; supportEnd: Rational; hold: null | { kind: 'derived-hold'; end: Rational } };
  };
  videoSpans: EditSpan[] | null;
  audioSpans: EditSpan[] | null;
  segmentDuration: Rational | null;
}
interface EditSpan { sourceStart: Rational; sourceEnd: Rational; presentationStart: Rational; rate: Rational }
/** S6e E3 (design §3.2 item 7, inner 960d483f): physical encode facts beside the plan, outside its identity. */
interface Encoding { keyframeOrdinals: number[]; codedWidth: number; codedHeight: number; sourceKeyframes: { pts: Rational; dts: Rational }[]; firstPacketDts: Rational }
interface Ledger { schemaVersion: 2; sourceFingerprint: string; toolInputId: string; planSha256: string; attempt: { jobId: string; deadlineAt: number }; plan: Plan; encoding: Encoding }
interface Compact { sourceFingerprint: string; toolInputId: string; planSha256: string; presentation: VideoPresentationTable }
interface VersionInput {
  sourceFingerprint: string; policyVersion: number; producerVersion: number; profileVersion: number; planSha256: string;
  display: Plan['display']; playback: { sha256: string; size: number; contentType: string };
}
interface ContractApi {
  videoPresentationVersionSchema: Schema<unknown>;
  alphaPackedManifestSchema: Schema<unknown>;
  alphaPackedManifestMatchesVersion: (manifest: unknown, version: unknown) => boolean;
  videoPresentationLedgerSchema: Schema<Ledger>;
  videoPresentationLedgerReceiptSchema: Schema<unknown>;
  videoPresentationCompactSchema: Schema<Compact>;
  videoPresentationRefSchema: Schema<unknown>;
  projectVideoPresentationCompact: (ledger: Ledger) => Compact;
  videoPresentationPlanSha256: (plan: unknown) => Promise<string>;
  videoPresentationToolInputId: (input: { sourceFingerprint: string; planSha256: string }) => Promise<string>;
  videoPresentationVersionId: (input: unknown) => Promise<string>;
  videoPresentationKeyframeFlags: (ledger: Ledger) => boolean[];
}

const api = entry as unknown as Partial<ContractApi>;

/**
 * Read one export of the S6a contract from the shared main entry, failing when it does not exist yet.
 * @param name - The export name.
 * @returns The export.
 * @throws {Error} When the export is missing.
 */
function required<K extends keyof ContractApi>(name: K): ContractApi[K] {
  const value = api[name];
  expect(value, `${name} is exported from @breatic/shared`).toBeDefined();
  return value as ContractApi[K];
}

/**
 * A reduced exact rational literal.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @returns The rational.
 */
function r(numerator: number, denominator = 1): Rational {
  return { numerator: String(numerator), denominator: String(denominator) };
}

/**
 * Lowercase SHA-256 of UTF-8 text, computed with WebCrypto only.
 * @param text - The text.
 * @returns The digest.
 */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Copy a value and replace one nested field.
 * @param value - The source value.
 * @param path - Keys from the root to the field.
 * @param replacement - The new value; `undefined` deletes the key.
 * @returns The patched copy.
 */
function patched<T>(value: T, path: readonly (string | number)[], replacement: unknown): T {
  const copy = structuredClone(value);
  let parent = copy as unknown as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  if (replacement === undefined) delete parent[path.at(-1)!];
  else parent[path.at(-1)!] = replacement;
  return copy;
}

const H = 'a'.repeat(64);
const TOOL = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const VERSION = 'e'.repeat(64);
const BYTES = 'f'.repeat(64);
const ATTEMPT = { jobId: 'video-presentation:job-1', deadlineAt: 1_800_000_000_000 };

/**
 * CFR 17 frames at 1/8 s with audio ending with the video: no derived frames.
 * @returns A fresh valid plan.
 */
function cfrPlan(): Plan {
  return {
    display: { width: 64, height: 48, duration: r(17, 8) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'black' },
    presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
    originMapping: {
      timeBase: r(1, 16384), origin: r(0), entries: [{ kind: 'source', start: 4096, count: 17, step: 2048 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(17, 8), hold: null },
    },
    videoSpans: [{ sourceStart: r(1, 4), sourceEnd: r(19, 8), presentationStart: r(0), rate: r(1) }],
    audioSpans: [{ sourceStart: r(8, 375), sourceEnd: r(6439, 3000), presentationStart: r(0), rate: r(1) }],
    segmentDuration: null,
  };
}

/**
 * Transparent source with audio from 0: the first frame (source 1/4) leads back to 0, an empty [1/2,3/4), a frame supported to 1 s and held to 2 s.
 * @returns A fresh valid plan.
 */
function gapHoldPlan(): Plan {
  return {
    display: { width: 96, height: 64, duration: r(2) }, colorMatrix: 'bt709', source: { transfer: 'bt709', bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 },
    policy: { singleFrameDurationMs: 5000, emptyFill: 'transparent' },
    presentation: { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 1, step: 2, duration: 2 }, { start: 2, count: 1, step: 1, duration: 1 }, { start: 3, count: 1, step: 5, duration: 5 }] },
    originMapping: {
      timeBase: r(1, 1024), origin: r(0),
      entries: [{ kind: 'source', start: 0, count: 1, step: 0 }, { kind: 'derived-empty' }, { kind: 'source', start: 512, count: 1, step: 0 }],
      firstSource: { supportStart: r(1, 4), lead: { kind: 'derived-lead', start: r(0) } },
      lastSource: { support: 'declared', supportEnd: r(1), hold: { kind: 'derived-hold', end: r(2) } },
    },
    videoSpans: [{ sourceStart: r(0), sourceEnd: r(1, 4), presentationStart: r(1, 4), rate: r(1) }, { sourceStart: r(1, 2), sourceEnd: r(3, 4), presentationStart: r(3, 4), rate: r(1) }],
    audioSpans: [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(0), rate: r(1) }],
    segmentDuration: null,
  };
}

/**
 * Opaque frames [0,1/4) and [3/4,1) around one empty [1/4,3/4), no audio; the first frame starts at movie time 1/8, rebased to 0.
 * @returns A fresh valid plan.
 */
function gapPlan(): Plan {
  return {
    display: { width: 64, height: 48, duration: r(1) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'black' },
    presentation: { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 1, step: 1, duration: 1 }, { start: 1, count: 1, step: 2, duration: 2 }, { start: 3, count: 1, step: 1, duration: 1 }] },
    originMapping: {
      timeBase: r(1, 1000), origin: r(1, 8),
      entries: [{ kind: 'source', start: 125, count: 1, step: 0 }, { kind: 'derived-empty' }, { kind: 'source', start: 875, count: 1, step: 0 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(1), hold: null },
    },
    videoSpans: null, audioSpans: null, segmentDuration: null,
  };
}

/**
 * The four-frame MediaRecorder sample (PTS 0/70/170/932 ms): previous-max support to 1.694 s, Info.Duration kept as a source fact.
 * @returns A fresh valid plan.
 */
function matroskaPlan(): Plan {
  return {
    display: { width: 320, height: 240, duration: r(847, 500) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'black' },
    presentation: projectPresentationTable([
      { displayStart: r(0), displayEnd: r(7, 100) }, { displayStart: r(7, 100), displayEnd: r(17, 100) },
      { displayStart: r(17, 100), displayEnd: r(233, 250) }, { displayStart: r(233, 250), displayEnd: r(847, 500) },
    ]),
    originMapping: {
      timeBase: r(1, 1000), origin: r(0), entries: [{ kind: 'source', start: 0, count: 2, step: 70 }, { kind: 'source', start: 170, count: 2, step: 762 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'previous-max', supportEnd: r(847, 500), hold: null },
    },
    videoSpans: null, audioSpans: null, segmentDuration: r(932267, 1_000_000),
  };
}

/**
 * A lone recorded frame with only a 1 ms Info.Duration: the 5000 ms single-frame support.
 * @returns A fresh valid plan.
 */
function singlePlan(): Plan {
  return {
    display: { width: 320, height: 240, duration: r(5) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'black' },
    presentation: { schemaVersion: 1, timescale: 1, runs: [{ start: 0, count: 1, step: 5, duration: 5 }] },
    originMapping: {
      timeBase: r(1, 1000), origin: r(0), entries: [{ kind: 'source', start: 0, count: 1, step: 0 }],
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'single-frame', supportEnd: r(5), hold: null },
    },
    videoSpans: null, audioSpans: null, segmentDuration: r(1, 1000),
  };
}

/**
 * A full ledger around a plan.
 * @param plan - The plan.
 * @returns A fresh valid ledger.
 */
function ledger(plan: Plan = cfrPlan()): Ledger {
  return { schemaVersion: 2, sourceFingerprint: H, toolInputId: TOOL, planSha256: PLAN, attempt: { ...ATTEMPT }, plan,
    encoding: { keyframeOrdinals: [0], codedWidth: plan.display.width, codedHeight: plan.display.height, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } };
}

const PLANS = [['cfr', cfrPlan], ['lead, gap and hold', gapHoldPlan], ['rebased gap', gapPlan], ['matroska previous-max', matroskaPlan], ['single frame', singlePlan]] as const;

/**
 * A carrier receipt.
 * @param name - Object name suffix.
 * @param contentType - The measured type.
 * @returns The receipt.
 */
function carrier(name: string, contentType = 'video/mp4'): ObjectReceipt {
  return { storageKey: `video/fixture/${name}`, url: `https://assets.example.test/video/fixture/${name}`, etag: `etag-${name}`, size: 4096, sha256: BYTES, contentType };
}

/**
 * A native selected version.
 * @returns A fresh valid descriptor.
 */
function nativeVersion(): Record<string, unknown> {
  return {
    // S6e E2 (design §3.5 P descriptor, inner 54ce9ea3): the bundle carries the producer and profile versions behind its versionId.
    schemaVersion: 1, sourceFingerprint: H, versionId: VERSION, toolInputId: TOOL, planSha256: PLAN, policyVersion: 1, producerVersion: 2, profileVersion: 1,
    original: { width: 64, height: 48, duration: 2.125 }, display: { width: 64, height: 48, duration: r(17, 8) },
    playback: { kind: 'native', carrier: carrier('original.mp4'), displayRect: null },
    playbackClock: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
  };
}

/**
 * An alpha-packed selected version with unknown registered measurements.
 * @returns A fresh valid descriptor.
 */
function alphaVersion(): Record<string, unknown> {
  return {
    ...nativeVersion(), original: { width: null, height: null, duration: null }, display: { width: 96, height: 64, duration: r(2) },
    playback: { kind: 'alpha-packed', carrier: carrier('job-1.packed.mp4'), manifest: { ...carrier('job-1.alpha.json', 'application/json'), sha256: 'b'.repeat(64), size: 300 } },
    playbackClock: { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 1, step: 2, duration: 2 }, { start: 2, count: 1, step: 1, duration: 1 }, { start: 3, count: 1, step: 5, duration: 5 }] },
  };
}

/**
 * The manifest of the alpha-packed version.
 * @returns A fresh valid manifest.
 */
function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1, versionId: VERSION, toolInputId: TOOL, planSha256: PLAN, policyVersion: 1, packed: carrier('job-1.packed.mp4'),
    packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 },
  };
}

/**
 * The receipt of a full ledger and its compact object.
 * @returns A fresh valid receipt.
 */
function receipt(): Record<string, unknown> {
  return {
    schemaVersion: 2, sourceFingerprint: H, toolInputId: TOOL, planSha256: PLAN, producerVersion: 2, attempt: { ...ATTEMPT },
    url: 'https://assets.example.test/video/fixture/job-1.full.json', etag: 'etag-full', size: 900, sha256: BYTES, contentType: 'application/json',
    table: { url: 'https://assets.example.test/video/fixture/job-1.compact.json', sha256: 'b'.repeat(64), size: 200, contentType: 'application/json', frameCount: 17 },
  };
}

/**
 * The version identity input for the native version.
 * @returns A fresh valid input.
 */
function versionInput(): VersionInput {
  return {
    sourceFingerprint: H, policyVersion: 1, producerVersion: 1, profileVersion: 1, planSha256: PLAN,
    display: { width: 64, height: 48, duration: r(17, 8) }, playback: { sha256: BYTES, size: 4096, contentType: 'video/mp4' },
  };
}

describe('I §3.2 toolInputId, planSha256 and versionId', () => {
  it('I01 toolInputId is the SHA-256 of the canonical {planSha256, sourceFingerprint} text', async () => {
    const id = await required('videoPresentationToolInputId')({ sourceFingerprint: H, planSha256: PLAN });
    expect(id).toBe(await sha256(`{"planSha256":"${PLAN}","sourceFingerprint":"${H}"}`));
  });

  it('I02 toolInputId depends on exactly the source fingerprint and the plan (property)', async () => {
    const toolInputId = required('videoPresentationToolInputId');
    const hex = fc.stringMatching(/^[a-f0-9]{64}$/);
    await fc.assert(fc.asyncProperty(hex, hex, async (sourceFingerprint, planSha256) => {
      expect(await toolInputId({ sourceFingerprint, planSha256 })).toBe(await sha256(`{"planSha256":"${planSha256}","sourceFingerprint":"${sourceFingerprint}"}`));
    }), { seed: 130601, numRuns: 50 });
  });

  it.each([['uppercase fingerprint', { sourceFingerprint: 'A'.repeat(64), planSha256: PLAN }], ['short plan', { sourceFingerprint: H, planSha256: 'd'.repeat(63) }], ['extra versionId', { sourceFingerprint: H, planSha256: PLAN, versionId: VERSION }]])('I03 toolInputId rejects %s', async (_, value) => {
    await expect(required('videoPresentationToolInputId')(value)).rejects.toThrow();
  });

  it.each(PLANS)('I04 planSha256 of the %s plan is the SHA-256 of its canonical JSON', async (_, make) => {
    const plan = make();
    expect(await required('videoPresentationPlanSha256')(plan)).toBe(await sha256(canonicalMiniToolValue(plan)));
  });

  it('I05 planSha256 ignores key order and changes with timing, policy values, colour matrix and geometry', async () => {
    const planSha256 = required('videoPresentationPlanSha256');
    const base = cfrPlan();
    const reordered = Object.fromEntries(Object.entries(base).reverse());
    expect(await planSha256(reordered)).toBe(await planSha256(base));
    const changes: [string, Plan][] = [
      ['single-frame policy', patched(base, ['policy', 'singleFrameDurationMs'], 1000)],
      ['empty fill', patched(base, ['policy', 'emptyFill'], 'transparent')],
      ['colour matrix', patched(base, ['colorMatrix'], 'bt709')],
      ['source transfer and its tone map', patched(patched(base, ['source', 'transfer'], 'smpte2084'), ['output', 'toneMap'], 'sdr-bt709')],
      ['source bit depth and its PNG depth', patched(patched(base, ['source', 'bitDepth'], 10), ['output', 'framePngBitDepth'], 16)],
      ['display height', patched(base, ['display', 'height'], 50)],
      ['source tick', patched(base, ['originMapping', 'entries', 0, 'start'], 4097)],
      ['video span', patched(base, ['videoSpans', 0, 'sourceStart'], r(1, 3))],
      ['audio spans', patched(base, ['audioSpans'], null)],
      ['segment duration', patched(base, ['segmentDuration'], r(1, 1000))],
    ];
    const hashes = new Set([await planSha256(base)]);
    for (const [, plan] of changes) hashes.add(await planSha256(plan));
    expect(hashes.size).toBe(changes.length + 1);
  });

  it.each([
    ['a carrier strategy', ['carrier'], { strategy: 'copy' }], ['an encoder setting', ['crf'], 18], ['a URL', ['url'], 'https://assets.example.test/x.mp4'],
    ['a versionId', ['versionId'], VERSION], ['a policyVersion', ['policyVersion'], 1], ['a manifest hash', ['manifestSha256'], BYTES],
    ['a table hash', ['tableSha256'], BYTES], ['a carrier width', ['display', 'carrierWidth'], 64],
  ] as const)('I06 planSha256 refuses a plan carrying %s', async (_, path, value) => {
    const planSha256 = required('videoPresentationPlanSha256');
    await expect(planSha256(cfrPlan())).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(planSha256(patched(cfrPlan(), path, value))).rejects.toThrow();
  });

  it('I07 versionId is the SHA-256 of the canonical version input', async () => {
    expect(await required('videoPresentationVersionId')(versionInput())).toBe(await sha256(canonicalMiniToolValue(versionInput())));
  });

  it.each([
    ['source fingerprint', ['sourceFingerprint'], 'b'.repeat(64)], ['policy version', ['policyVersion'], 2], ['producer version', ['producerVersion'], 2],
    ['profile version', ['profileVersion'], 2], ['plan', ['planSha256'], 'b'.repeat(64)], ['display width', ['display', 'width'], 65],
    ['display duration', ['display', 'duration'], r(9, 4)], ['carrier bytes', ['playback', 'sha256'], 'b'.repeat(64)],
    ['carrier size', ['playback', 'size'], 4097], ['carrier type', ['playback', 'contentType'], 'video/webm'],
  ] as const)('I08 versionId changes with the %s', async (_, path, value) => {
    const versionId = required('videoPresentationVersionId');
    expect(await versionId(patched(versionInput(), path, value))).not.toBe(await versionId(versionInput()));
  });

  it.each([
    ['the carrier URL', ['playback', 'url'], 'https://assets.example.test/x.mp4'], ['the carrier etag', ['playback', 'etag'], 'etag-1'],
    ['the carrier storage key', ['playback', 'storageKey'], 'video/x.mp4'], ['the alpha manifest', ['manifest'], { sha256: BYTES, size: 300 }],
    ['the toolInputId', ['toolInputId'], TOOL],
  ] as const)('I09 versionId refuses an input carrying %s', async (_, path, value) => {
    const versionId = required('videoPresentationVersionId');
    await expect(versionId(versionInput())).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(versionId(patched(versionInput(), path, value))).rejects.toThrow();
  });

  it('I10 a re-encoded carrier gives a new versionId while the toolInputId stays', async () => {
    const plan = await required('videoPresentationPlanSha256')(cfrPlan());
    const toolInputId = await required('videoPresentationToolInputId')({ sourceFingerprint: H, planSha256: plan });
    const first = { ...versionInput(), planSha256: plan };
    const second = patched(first, ['playback'], { sha256: 'b'.repeat(64), size: 5000, contentType: 'video/mp4' });
    expect(await required('videoPresentationVersionId')(second)).not.toBe(await required('videoPresentationVersionId')(first));
    expect(await required('videoPresentationToolInputId')({ sourceFingerprint: H, planSha256: plan })).toBe(toolInputId);
  });
});

describe('P §3.5 selected presentation version descriptor', () => {
  it.each([['native', nativeVersion], ['alpha-packed', alphaVersion]] as const)('P01 accepts the %s version unchanged', (_, make) => {
    expect(required('videoPresentationVersionSchema').parse(make())).toEqual(make());
  });

  it.each([
    ['v1 native', { schemaVersion: 1, sourceFingerprint: H, original: { width: 96, height: 64, duration: 1 }, state: 'native' }],
    ['v1 alpha ready', { schemaVersion: 1, sourceFingerprint: H, original: { width: 96, height: 64, duration: 1 }, state: 'alpha_ready', alpha: { manifestURL: 'https://assets.example.test/x.alpha.v1.json' } }],
    ['v1 classifying', { schemaVersion: 1, sourceFingerprint: H, original: { width: 96, height: 64, duration: 1 }, state: 'classifying', attempt: ATTEMPT }],
  ])('P02 rejects the earlier %s descriptor', (_, value) => {
    const schema = required('videoPresentationVersionSchema');
    expect(schema.safeParse(nativeVersion()).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['missing versionId', ['versionId'], undefined], ['missing toolInputId', ['toolInputId'], undefined], ['missing planSha256', ['planSha256'], undefined],
    ['missing policyVersion', ['policyVersion'], undefined], ['missing producerVersion', ['producerVersion'], undefined], ['missing profileVersion', ['profileVersion'], undefined],
    ['zero producerVersion', ['producerVersion'], 0], ['fractional profileVersion', ['profileVersion'], 1.5], ['missing playback', ['playback'], undefined], ['missing playbackClock', ['playbackClock'], undefined],
    ['missing sourceFingerprint', ['sourceFingerprint'], undefined], ['missing display', ['display'], undefined], ['missing original', ['original'], undefined],
    ['uppercase versionId', ['versionId'], 'E'.repeat(64)], ['short toolInputId', ['toolInputId'], 'c'.repeat(63)],
    ['a pending state', ['state'], 'classifying'], ['an unknown field', ['config'], { info: { v: 2 } }],
    ['zero display width', ['display', 'width'], 0], ['fractional display height', ['display', 'height'], 1.5],
    ['a floating display duration', ['display', 'duration'], 2.125], ['zero display duration', ['display', 'duration'], r(0)],
    ['negative display duration', ['display', 'duration'], r(-17, 8)], ['unreduced display duration', ['display', 'duration'], r(34, 16)],
    ['zero-denominator display duration', ['display', 'duration'], { numerator: '1', denominator: '0' }],
    ['zero original width', ['original', 'width'], 0], ['zero original duration', ['original', 'duration'], 0],
    ['an http carrier', ['playback', 'carrier', 'url'], 'http://assets.example.test/video/fixture/original.mp4'],
    ['a zero-size carrier', ['playback', 'carrier', 'size'], 0], ['a bad carrier digest', ['playback', 'carrier', 'sha256'], 'F'.repeat(64)],
    ['a carrier without storage key', ['playback', 'carrier', 'storageKey'], undefined], ['a carrier without etag', ['playback', 'carrier', 'etag'], undefined],
    ['a native manifest', ['playback', 'manifest'], carrier('x.alpha.json', 'application/json')], ['an unknown playback kind', ['playback', 'kind'], 'hls'],
    ['an invalid playback clock', ['playbackClock', 'runs'], []], ['a playback clock that is not an S1 table', ['playbackClock'], { timescale: 1000, offset: 0 }],
    ['schemaVersion 2', ['schemaVersion'], 2], ['a native carrier without displayRect', ['playback', 'displayRect'], undefined],
    ['a zero-width displayRect', ['playback', 'displayRect'], { x: 0, y: 0, width: 0, height: 97 }], ['a negative displayRect origin', ['playback', 'displayRect'], { x: -1, y: 0, width: 161, height: 97 }],
    ['a fractional displayRect', ['playback', 'displayRect'], { x: 0, y: 0, width: 160.5, height: 97 }], ['a displayRect with extra fields', ['playback', 'displayRect'], { x: 0, y: 0, width: 161, height: 97, rotation: 0 }],
  ] as const)('P03 rejects %s', (_, path, value) => {
    const schema = required('videoPresentationVersionSchema');
    expect(schema.safeParse(nativeVersion()).success).toBe(true);
    expect(schema.safeParse(patched(nativeVersion(), path, value)).success).toBe(false);
  });

  it('P05 a native carrier padded to even records the actual picture rectangle; an unpadded one records null', () => {
    const schema = required('videoPresentationVersionSchema');
    const odd = { ...nativeVersion(), display: { width: 161, height: 97, duration: r(17, 8) }, playback: { kind: 'native', carrier: carrier('job-1.carrier.mp4'), displayRect: { x: 0, y: 0, width: 161, height: 97 } } };
    expect(schema.parse(odd)).toEqual(odd);
    expect(schema.parse(nativeVersion())).toEqual(nativeVersion());
  });

  it('P06 an alpha-packed version keeps its rectangles in the manifest, not in playback', () => {
    const schema = required('videoPresentationVersionSchema');
    expect(schema.safeParse(alphaVersion()).success).toBe(true);
    expect(schema.safeParse(patched(alphaVersion(), ['playback', 'displayRect'], { x: 0, y: 0, width: 96, height: 64 })).success).toBe(false);
    expect(schema.safeParse(patched(alphaVersion(), ['playback', 'displayRect'], null)).success).toBe(false);
  });

  it('P04 rejects an alpha-packed version without its manifest receipt', () => {
    const schema = required('videoPresentationVersionSchema');
    expect(schema.safeParse(alphaVersion()).success).toBe(true);
    expect(schema.safeParse(patched(alphaVersion(), ['playback', 'manifest'], undefined)).success).toBe(false);
  });
});

describe('M §3.5 alpha-packed manifest', () => {
  it('M01 accepts the manifest of the alpha-packed version and matches it', () => {
    expect(required('alphaPackedManifestSchema').parse(manifest())).toEqual(manifest());
    expect(required('alphaPackedManifestMatchesVersion')(manifest(), alphaVersion())).toBe(true);
  });

  it.each([
    ['another versionId', ['versionId'], 'b'.repeat(64)], ['another toolInputId', ['toolInputId'], 'b'.repeat(64)],
    ['another planSha256', ['planSha256'], 'b'.repeat(64)], ['another policyVersion', ['policyVersion'], 2],
    ['other packed bytes', ['packed', 'sha256'], 'b'.repeat(64)], ['another packed object', ['packed', 'url'], 'https://assets.example.test/video/fixture/job-2.packed.mp4'],
    ['a colour rectangle smaller than the display', ['colorRect'], { x: 0, y: 0, width: 48, height: 32 }],
  ] as const)('M02 does not match a manifest with %s', (_, path, value) => {
    const matches = required('alphaPackedManifestMatchesVersion');
    expect(matches(manifest(), alphaVersion())).toBe(true);
    const changed = patched(manifest(), path, value);
    if (path[0] === 'colorRect') changed.alphaRect = { x: 96, y: 0, width: 48, height: 32 };
    expect(required('alphaPackedManifestSchema').safeParse(changed).success).toBe(true);
    expect(matches(changed, alphaVersion())).toBe(false);
  });

  it('M02 does not match a native version', () => {
    expect(required('alphaPackedManifestMatchesVersion')(manifest(), { ...nativeVersion(), display: { width: 96, height: 64, duration: r(2) } })).toBe(false);
  });

  it.each([
    ['the v1 manifest', { schemaVersion: 1, sourceFingerprint: H, packedURL: 'https://assets.example.test/x.alpha.v1.mp4', packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 } }],
    ['overlapping rectangles', patched(manifest(), ['alphaRect', 'x'], 0)],
    ['a rectangle outside the packed frame', patched(manifest(), ['packedHeight'], 63)],
    ['unequal colour and alpha sizes', patched(manifest(), ['alphaRect', 'width'], 48)],
    ['a missing versionId', patched(manifest(), ['versionId'], undefined)], ['schemaVersion 2', patched(manifest(), ['schemaVersion'], 2)],
    ['an http packed object', patched(manifest(), ['packed', 'url'], 'http://assets.example.test/video/fixture/job-1.packed.mp4')],
  ])('M03 rejects %s', (_, value) => {
    const schema = required('alphaPackedManifestSchema');
    expect(schema.safeParse(manifest()).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
  });

  // §97 (coverage moved off the earlier `alphaManifestSchema`, which is deleted with its tests): the geometry checks the
  // new manifest still runs through `pixel`, `rect` and `checkPackedGeometry` (design §3.5 alpha manifest row). Each case
  // changes both rectangles alike where one alone would also trip the equal-size check, so only the named check refuses it.
  it.each([
    ['an alpha rectangle beyond the packed width', patched(manifest(), ['alphaRect', 'x'], 97)],
    ['a negative rectangle coordinate', patched(manifest(), ['colorRect', 'x'], -1)],
    ['a zero-width picture', patched(patched(manifest(), ['colorRect', 'width'], 0), ['alphaRect', 'width'], 0)],
    ['a fractional picture height', patched(patched(manifest(), ['colorRect', 'height'], 1.5), ['alphaRect', 'height'], 1.5)],
  ])('M04 rejects %s', (_, value) => {
    const schema = required('alphaPackedManifestSchema');
    expect(schema.safeParse(manifest()).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('M05 accepts an odd 95x63 picture padded inside a 192x64 packed frame (encoder alignment)', () => {
    const padded = { ...manifest(), colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
    expect(required('alphaPackedManifestSchema').safeParse(padded).success).toBe(true);
  });
});

describe('L §3.5 full ledger: the plan with its origin mapping', () => {
  it.each(PLANS)('L01 accepts the %s ledger unchanged', (_, make) => {
    expect(required('videoPresentationLedgerSchema').parse(ledger(make()))).toEqual(ledger(make()));
  });

  it.each([
    ['PQ 10-bit tone mapped to 8-bit SDR', { transfer: 'smpte2084', bitDepth: 10 }, { toneMap: 'sdr-bt709', framePngBitDepth: 8 }],
    ['HLG 10-bit tone mapped to 8-bit SDR', { transfer: 'arib-std-b67', bitDepth: 10 }, { toneMap: 'sdr-bt709', framePngBitDepth: 8 }],
    ['10-bit SDR with 16-bit frame PNGs', { transfer: 'bt709', bitDepth: 10 }, { toneMap: 'none', framePngBitDepth: 16 }],
    ['8-bit BT.709', { transfer: 'bt709', bitDepth: 8 }, { toneMap: 'none', framePngBitDepth: 8 }],
  ])('L01 accepts a plan for %s', (_, source, output) => {
    const plan = { ...cfrPlan(), source, output } as Plan;
    expect(required('videoPresentationLedgerSchema').parse(ledger(plan))).toEqual(ledger(plan));
  });

  it('L02 rejects the earlier v2 ledger shape', () => {
    const schema = required('videoPresentationLedgerSchema');
    expect(schema.safeParse(ledger()).success).toBe(true);
    expect(schema.safeParse({
      schemaVersion: 2, sourceFingerprint: H, producerVersion: 2, attempt: ATTEMPT,
      presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
      source: { timeBase: r(1, 16384), runs: [{ start: 4096, count: 17, step: 2048 }] },
      videoEdits: [{ sourceStart: r(1, 4), sourceEnd: r(19, 8), presentationStart: r(0), rate: r(1) }], audioEdits: null,
    }).success).toBe(false);
  });

  it.each([
    ['a versionId', ['versionId'], VERSION], ['a policyVersion', ['policyVersion'], 1],
    ['a carrier strategy in the plan', ['plan', 'carrier'], { strategy: 'copy' }], ['an encoder setting in the plan', ['plan', 'crf'], 18],
    ['producer physical frames', ['plan', 'physical'], { frames: [] }], ['container blocks', ['plan', 'container'], { kind: 'matroska', blocks: [] }],
    ['a raw decode ordinal', ['plan', 'originMapping', 'entries', 0, 'rawDecodeOrdinal'], 0], ['the earlier videoEdits name', ['plan', 'videoEdits'], null],
    ['an unknown top-level field', ['frames'], []],
  ] as const)('L03 rejects %s', (_, path, value) => {
    const schema = required('videoPresentationLedgerSchema');
    expect(schema.safeParse(ledger()).success).toBe(true);
    expect(schema.safeParse(patched(ledger(), path, value)).success).toBe(false);
  });

  // Frames [0,1/4), empty [1/4,1/2), empty [1/2,3/4), [3/4,1): only the two adjacent derived-empty frames are wrong.
  const adjacent = patched(patched(gapPlan(), ['presentation', 'runs'], [{ start: 0, count: 4, step: 1, duration: 1 }]), ['originMapping', 'entries'], [
    { kind: 'source', start: 125, count: 1, step: 0 }, { kind: 'derived-empty' }, { kind: 'derived-empty' }, { kind: 'source', start: 875, count: 1, step: 0 },
  ]);
  const invalid: [string, Plan][] = [
    ['fewer origin entries than frames', patched(gapHoldPlan(), ['originMapping', 'entries'], gapHoldPlan().originMapping.entries.slice(0, 2))],
    ['more origin frames than presented frames', patched(cfrPlan(), ['originMapping', 'entries', 0, 'count'], 18)],
    ['two adjacent derived-empty frames', adjacent],
    // Frame 0 [0,1/4) is derived-empty while firstSource (supportStart 0, no lead) agrees with frame 0: only the first-frame rule is wrong.
    ['a derived-empty first frame', patched(gapPlan(), ['originMapping', 'entries'], [{ kind: 'derived-empty' }, { kind: 'source', start: 125, count: 1, step: 0 }, { kind: 'source', start: 875, count: 1, step: 0 }])],
    ['no source frame at all', patched(singlePlan(), ['originMapping', 'entries'], [{ kind: 'derived-empty' }])],
    ['a hold while a derived-empty frame is last', patched(gapHoldPlan(), ['originMapping', 'entries'], [{ kind: 'source', start: 0, count: 1, step: 0 }, { kind: 'source', start: 512, count: 1, step: 0 }, { kind: 'derived-empty' }])],
    ['a hold ending before the last display end', patched(gapHoldPlan(), ['originMapping', 'lastSource', 'hold', 'end'], r(7, 4))],
    ['a hold whose support reaches the display end', patched(gapHoldPlan(), ['originMapping', 'lastSource', 'supportEnd'], r(2))],
    ['a support end at the frame start', patched(gapHoldPlan(), ['originMapping', 'lastSource', 'supportEnd'], r(3, 4))],
    ['a support end short of the display end without a hold', patched(cfrPlan(), ['originMapping', 'lastSource', 'supportEnd'], r(2))],
    ['a hold kind other than derived-hold', patched(gapHoldPlan(), ['originMapping', 'lastSource', 'hold', 'kind'], 'hold')],
    ['a next-start rule on the last frame', patched(cfrPlan(), ['originMapping', 'lastSource', 'support'], 'next-start')],
    ['a lead not starting at the presentation start', patched(gapHoldPlan(), ['originMapping', 'firstSource', 'lead', 'start'], r(1, 8))],
    ['a lead whose support start reaches the first display end', patched(gapHoldPlan(), ['originMapping', 'firstSource', 'supportStart'], r(1, 2))],
    ['a zero-length lead', patched(gapHoldPlan(), ['originMapping', 'firstSource', 'supportStart'], r(0))],
    ['a support start after the display start without a lead', patched(gapHoldPlan(), ['originMapping', 'firstSource', 'lead'], null)],
    ['a lead kind other than derived-lead', patched(gapHoldPlan(), ['originMapping', 'firstSource', 'lead', 'kind'], 'lead')],
    ['a missing first-source record', patched(gapHoldPlan(), ['originMapping', 'firstSource'], undefined)],
    ['a missing origin', patched(gapPlan(), ['originMapping', 'origin'], undefined)],
    ['a negative origin', patched(gapPlan(), ['originMapping', 'origin'], r(-1, 8))],
    ['a display duration other than the presentation end', patched(cfrPlan(), ['display', 'duration'], r(2))],
    ['a presentation not starting at zero', patched(patched(patched(cfrPlan(), ['presentation', 'runs', 0, 'start'], 1), ['display', 'duration'], r(9, 4)), ['originMapping', 'lastSource', 'supportEnd'], r(9, 4))],
    ['a gap between runs', patched(patched(gapHoldPlan(), ['presentation', 'runs', 2], { start: 4, count: 1, step: 4, duration: 4 }), ['originMapping', 'lastSource', 'supportEnd'], r(5, 4))],
    ['a gap inside a run', patched(patched(patched(cfrPlan(), ['presentation', 'runs', 0], { start: 0, count: 17, step: 2, duration: 1 }), ['display', 'duration'], r(33, 8)), ['originMapping', 'lastSource', 'supportEnd'], r(33, 8))],
    ['a single-frame source run with a step', patched(singlePlan(), ['originMapping', 'entries', 0, 'step'], 40)],
    ['a multi-frame source run without a step', patched(cfrPlan(), ['originMapping', 'entries', 0, 'step'], 0)],
    ['a zero source time base', patched(cfrPlan(), ['originMapping', 'timeBase'], r(0))],
    ['a zero single-frame policy', patched(cfrPlan(), ['policy', 'singleFrameDurationMs'], 0)],
    ['an unknown empty fill', patched(cfrPlan(), ['policy', 'emptyFill'], 'grey')],
    ['a missing colour matrix', patched(cfrPlan(), ['colorMatrix'], undefined)],
    ['a missing source transfer and bit depth', patched(cfrPlan(), ['source'], undefined)],
    ['a missing output conversion', patched(cfrPlan(), ['output'], undefined)],
    ['an HDR (PQ) source without the tone map', patched(cfrPlan(), ['source', 'transfer'], 'smpte2084')],
    ['an HDR (HLG) source with 16-bit frame PNGs', patched(patched(patched(cfrPlan(), ['source'], { transfer: 'arib-std-b67', bitDepth: 10 }), ['output', 'toneMap'], 'sdr-bt709'), ['output', 'framePngBitDepth'], 16)],
    ['an SDR source with a tone map', patched(cfrPlan(), ['output', 'toneMap'], 'sdr-bt709')],
    ['a 10-bit SDR source with 8-bit frame PNGs', patched(cfrPlan(), ['source', 'bitDepth'], 10)],
    ['an 8-bit source with 16-bit frame PNGs', patched(cfrPlan(), ['output', 'framePngBitDepth'], 16)],
    ['a zero source bit depth', patched(cfrPlan(), ['source', 'bitDepth'], 0)],
    ['zero display width', patched(cfrPlan(), ['display', 'width'], 0)],
    ['a zero-rate video span', patched(cfrPlan(), ['videoSpans', 0, 'rate'], r(0))],
    ['an empty video span list', patched(cfrPlan(), ['videoSpans'], [])],
  ];
  it.each(invalid)('L04 rejects %s', (_, plan) => {
    const schema = required('videoPresentationLedgerSchema');
    expect(schema.safeParse(ledger()).success).toBe(true);
    expect(schema.safeParse(ledger(plan)).success).toBe(false);
  });

  it.each([['uppercase toolInputId', ['toolInputId'], 'C'.repeat(64)], ['short planSha256', ['planSha256'], 'd'.repeat(63)], ['missing attempt', ['attempt'], undefined], ['empty job id', ['attempt', 'jobId'], ''], ['schemaVersion 1', ['schemaVersion'], 1]] as const)('L05 rejects %s', (_, path, value) => {
    const schema = required('videoPresentationLedgerSchema');
    expect(schema.safeParse(ledger()).success).toBe(true);
    expect(schema.safeParse(patched(ledger(), path, value)).success).toBe(false);
  });
});

/**
 * Build a valid plan from generated declared frames with gaps and an optional audio hold, as §4.2.1 and §7.16 lay them out:
 * the first frame's gap is rebased away (no earlier audio), later gaps are derived-empty frames.
 * @param frames - Gap before and length of each frame, in units of 1/25 s.
 * @param audioEnd - Audio end in units, or null.
 * @returns The plan.
 */
function generatedPlan(frames: readonly { gap: number; length: number }[], audioEnd: number | null): Plan {
  const windows: { displayStart: Rational; displayEnd: Rational; kind: 'source' | 'derived-empty' }[] = [];
  let cursor = 0;
  for (const [index, frame] of frames.entries()) {
    if (index === 0) { windows.push({ displayStart: r(0), displayEnd: reduce(frame.length, 25), kind: 'source' }); cursor = frame.length; continue; }
    if (frame.gap > 0) windows.push({ displayStart: reduce(cursor, 25), displayEnd: reduce(cursor + frame.gap, 25), kind: 'derived-empty' });
    cursor += frame.gap;
    windows.push({ displayStart: reduce(cursor, 25), displayEnd: reduce(cursor + frame.length, 25), kind: 'source' });
    cursor += frame.length;
  }
  const supportEnd = reduce(cursor, 25);
  const held = audioEnd !== null && audioEnd > cursor;
  if (held) windows[windows.length - 1]!.displayEnd = reduce(audioEnd, 25);
  const end = held ? reduce(audioEnd, 25) : supportEnd;
  return {
    display: { width: 64, height: 48, duration: end }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'black' },
    presentation: projectPresentationTable(windows),
    originMapping: {
      timeBase: r(1, 90000), origin: reduce(frames[0]!.gap, 25),
      entries: windows.map((window, index): OriginEntry => (window.kind === 'source' ? { kind: 'source', start: index * 3000, count: 1, step: 0 } : { kind: 'derived-empty' })),
      firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd, hold: held ? { kind: 'derived-hold', end } : null },
    },
    videoSpans: null, audioSpans: null, segmentDuration: null,
  };
}

/**
 * Reduce a fraction with a positive denominator.
 * @param numerator - The numerator.
 * @param denominator - A positive denominator.
 * @returns The reduced rational.
 */
function reduce(numerator: number, denominator: number): Rational {
  let a = Math.abs(numerator);
  let b = denominator;
  while (b !== 0) [a, b] = [b, a % b];
  return a === 0 ? r(0) : r(numerator / a, denominator / a);
}

const generatedFrames = fc.array(fc.record({ gap: fc.integer({ min: 0, max: 5 }), length: fc.integer({ min: 1, max: 5 }) }), { minLength: 1, maxLength: 30 });

describe('E §3.2 item 7 the full ledger\'s encode facts (inner 960d483f)', () => {
  it('E01 the full ledger requires its encoding sibling', () => {
    const schema = required('videoPresentationLedgerSchema');
    const { encoding: _dropped, ...without } = ledger();
    expect(schema.safeParse(ledger()).success).toBe(true);
    expect(schema.safeParse(without).success).toBe(false);
  });

  it.each([
    ['keyframes out of order', { keyframeOrdinals: [0, 8, 4], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['a repeated keyframe', { keyframeOrdinals: [0, 4, 4], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['a keyframe past the last presented frame', { keyframeOrdinals: [0, 17], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['a negative keyframe', { keyframeOrdinals: [-1, 0], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['a fractional keyframe', { keyframeOrdinals: [0, 1.5], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['a zero coded width', { keyframeOrdinals: [0], codedWidth: 0, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['a fractional coded height', { keyframeOrdinals: [0], codedWidth: 64, codedHeight: 48.5, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
    ['an unknown key', { keyframeOrdinals: [0], codedWidth: 64, codedHeight: 48, gop: 12, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) }],
  ])('E02 rejects encoding with %s', (_, encoding) => {
    const schema = required('videoPresentationLedgerSchema');
    expect(schema.safeParse({ ...ledger(), encoding: { keyframeOrdinals: [0, 4, 8, 16], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } }).success).toBe(true);
    expect(schema.safeParse({ ...ledger(), encoding }).success).toBe(false);
  });

  it('E03 the encode facts stay outside the plan identity: planSha256 and toolInputId do not change with them', async () => {
    const planSha = required('videoPresentationPlanSha256');
    const toolInputId = required('videoPresentationToolInputId');
    const a = { ...ledger(), encoding: { keyframeOrdinals: [0], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } };
    const b = { ...ledger(), encoding: { keyframeOrdinals: [0, 4, 8, 12, 16], codedWidth: 1920, codedHeight: 1088, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } };
    expect(await planSha(a.plan)).toBe(await planSha(b.plan));
    expect(await toolInputId({ sourceFingerprint: H, planSha256: await planSha(a.plan) })).toBe(await toolInputId({ sourceFingerprint: H, planSha256: await planSha(b.plan) }));
  });

  it('E04 the compact projection carries no encode facts', () => {
    const compact = required('projectVideoPresentationCompact')({ ...ledger(), encoding: { keyframeOrdinals: [0, 8], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } });
    expect(Object.keys(compact).sort()).toEqual(['planSha256', 'presentation', 'sourceFingerprint', 'toolInputId']);
  });

  // §93 D6-1 (design §3.2 item 7): every source keyframe's pts and dts (presented or not) and the stream's first packet dts,
  // as exact rationals like the ledger's other times; dts and firstPacketDts may be negative (negative CTS offsets), pts may not.
  const KEYFRAMES = { keyframeOrdinals: [0, 8], codedWidth: 64, codedHeight: 48,
    sourceKeyframes: [{ pts: r(0), dts: r(-1, 25) }, { pts: r(8, 25), dts: r(7, 25) }], firstPacketDts: r(-1, 25) };

  it('E06 the encoding carries every source keyframe\'s pts and dts and the first packet dts, negative dts included', () => {
    const schema = required('videoPresentationLedgerSchema');
    const value = { ...ledger(), encoding: KEYFRAMES };
    expect(schema.parse(value)).toEqual(value);
    // A keyframe the plan does not present is listed too: here the source's first keyframe precedes the presentation.
    const unpresented = { ...ledger(), encoding: { ...KEYFRAMES, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } };
    expect(schema.parse(unpresented)).toEqual(unpresented);
  });

  it.each([
    ['no source keyframes field', (({ sourceKeyframes: _k, ...rest }) => rest)(KEYFRAMES)],
    ['no first packet dts', (({ firstPacketDts: _f, ...rest }) => rest)(KEYFRAMES)],
    ['a negative keyframe pts', { ...KEYFRAMES, sourceKeyframes: [{ pts: r(-1, 25), dts: r(-2, 25) }] }],
    ['a keyframe time that is not reduced', { ...KEYFRAMES, sourceKeyframes: [{ pts: { numerator: '2', denominator: '50' }, dts: r(1, 25) }] }],
    ['a tick count instead of an exact time', { ...KEYFRAMES, firstPacketDts: -1 }],
    ['a keyframe without its dts', { ...KEYFRAMES, sourceKeyframes: [{ pts: r(0) }] }],
  ])('E07 rejects encoding with %s', (_, encoding) => {
    const schema = required('videoPresentationLedgerSchema');
    expect(schema.safeParse({ ...ledger(), encoding: KEYFRAMES }).success).toBe(true);
    expect(schema.safeParse({ ...ledger(), encoding }).success).toBe(false);
  });

  it('E05 the keyframe flags expand the ordinals to one flag per presented frame, ready for planVideoEncodeChunks', () => {
    const flags = required('videoPresentationKeyframeFlags');
    const value = { ...ledger(), encoding: { keyframeOrdinals: [0, 4, 9], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: r(0), dts: r(0) }], firstPacketDts: r(0) } };
    const expected = Array.from({ length: 17 }, (_, index) => [0, 4, 9].includes(index));
    expect(flags(value)).toEqual(expected);
  });
});

describe('L/C ledger round trip and §7.16 compact projection (property)', () => {
  it('L06 any generated ledger round-trips through JSON unchanged', () => {
    const schema = required('videoPresentationLedgerSchema');
    fc.assert(fc.property(generatedFrames, fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }), (frames, audioEnd) => {
      const value = ledger(generatedPlan(frames, audioEnd));
      expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    }), { seed: 130602, numRuns: 200 });
  });

  it.each(PLANS)('C01 projects the %s ledger to the four-field envelope around its presentation table', (_, make) => {
    const value = ledger(make());
    const compact = required('projectVideoPresentationCompact')(value);
    expect(compact).toEqual({ sourceFingerprint: H, toolInputId: TOOL, planSha256: PLAN, presentation: make().presentation });
    expect(required('videoPresentationCompactSchema').parse(compact)).toEqual(compact);
  });

  it('C02 the projection keeps every presented frame, one per origin entry, and is pure (property)', () => {
    const project = required('projectVideoPresentationCompact');
    fc.assert(fc.property(generatedFrames, fc.option(fc.integer({ min: 0, max: 400 }), { nil: null }), (frames, audioEnd) => {
      const value = structuredClone(ledger(generatedPlan(frames, audioEnd)));
      const frozen = JSON.parse(JSON.stringify(value)) as Ledger;
      const compact = project(value);
      expect(value).toEqual(frozen);
      expect(project(value)).toEqual(compact);
      const sourced = value.plan.originMapping.entries.reduce((total, item) => total + (item.kind === 'source' ? item.count : 1), 0);
      expect(presentationFrameCount(compact.presentation)).toBe(sourced);
      expect(compact.presentation).toEqual(value.plan.presentation);
      // Leads and holds add no frame: the real frames plus one per gap after the first frame.
      expect(sourced).toBe(frames.length + frames.slice(1).filter((frame) => frame.gap > 0).length);
      expect(value.plan.originMapping.entries[0]!.kind).toBe('source');
    }), { seed: 130603, numRuns: 200 });
  });
});

describe('C §3.5 compact body envelope', () => {
  const valid = (): Compact => ({ sourceFingerprint: H, toolInputId: TOOL, planSha256: PLAN, presentation: cfrPlan().presentation });

  it('C03 rejects the bare S1 table that the compact object used to be', () => {
    const schema = required('videoPresentationCompactSchema');
    expect(schema.parse(valid())).toEqual(valid());
    expect(schema.safeParse(cfrPlan().presentation).success).toBe(false);
  });

  it.each([
    ['missing sourceFingerprint', ['sourceFingerprint'], undefined], ['missing toolInputId', ['toolInputId'], undefined],
    ['missing planSha256', ['planSha256'], undefined], ['missing presentation', ['presentation'], undefined],
    ['frames', ['frames'], []], ['a versionId', ['versionId'], VERSION], ['a policyVersion', ['policyVersion'], 1], ['an origin mapping', ['originMapping'], {}],
    ['an invalid inner table', ['presentation', 'runs'], []], ['an uppercase toolInputId', ['toolInputId'], 'C'.repeat(64)],
    ['a top-level schemaVersion', ['schemaVersion'], 1],
  ] as const)('C04 rejects an envelope with %s', (_, path, value) => {
    const schema = required('videoPresentationCompactSchema');
    expect(schema.safeParse(valid()).success).toBe(true);
    expect(schema.safeParse(patched(valid(), path, value)).success).toBe(false);
  });
});

describe('R §3.5 receipt of the full ledger and the compact object', () => {
  it('R01 accepts a receipt bound to toolInputId and planSha256', () => {
    expect(required('videoPresentationLedgerReceiptSchema').parse(receipt())).toEqual(receipt());
  });

  it.each([
    ['the earlier v2 receipt', { schemaVersion: 2, sourceFingerprint: H, producerVersion: 2, attempt: ATTEMPT, url: 'https://assets.example.test/a.json', etag: 'e', size: 900, sha256: BYTES, contentType: 'application/json', table: { url: 'https://assets.example.test/b.json', sha256: BYTES, size: 200, frameCount: 17 } }],
    ['a missing toolInputId', patched(receipt(), ['toolInputId'], undefined)], ['a missing planSha256', patched(receipt(), ['planSha256'], undefined)],
    ['a versionId', patched(receipt(), ['versionId'], VERSION)], ['a policyVersion', patched(receipt(), ['policyVersion'], 1)],
    ['a missing attempt', patched(receipt(), ['attempt'], undefined)], ['schemaVersion 1', patched(receipt(), ['schemaVersion'], 1)],
    ['a missing table contentType', patched(receipt(), ['table', 'contentType'], undefined)], ['a non-JSON table contentType', patched(receipt(), ['table', 'contentType'], 'text/plain')],
    ['the table at the ledger URL', patched(receipt(), ['table', 'url'], 'https://assets.example.test/video/fixture/job-1.full.json')],
    ['an http ledger URL', patched(receipt(), ['url'], 'http://assets.example.test/video/fixture/job-1.full.json')],
    ['a zero ledger size', patched(receipt(), ['size'], 0)], ['a non-JSON ledger type', patched(receipt(), ['contentType'], 'application/octet-stream')],
    ['a zero table frame count', patched(receipt(), ['table', 'frameCount'], 0)], ['a bad table digest', patched(receipt(), ['table', 'sha256'], 'b'.repeat(63))],
    ['an unknown table field', patched(receipt(), ['table', 'versionId'], VERSION)],
  ])('R02 rejects %s', (_, value) => {
    const schema = required('videoPresentationLedgerReceiptSchema');
    expect(schema.safeParse(receipt()).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
  });
});

describe('X §3.5 accepted execution presentationRef map', () => {
  const ref = (planSha256 = PLAN): { toolInputId: string; planSha256: string } => ({ toolInputId: TOOL, planSha256 });

  it.each([['one input', { video: ref() }], ['two transition inputs', { 'clip-a': ref(), 'clip-b': { toolInputId: 'b'.repeat(64), planSha256: 'b'.repeat(64) } }]])('X01 accepts %s', (_, value) => {
    expect(required('videoPresentationRefSchema').parse(value)).toEqual(value);
  });

  it.each([
    ['an empty map', {}], ['an empty input id', { '': ref() }], ['a missing planSha256', { video: { toolInputId: TOOL } }],
    ['a missing toolInputId', { video: { planSha256: PLAN } }], ['a versionId in the entry', { video: { ...ref(), versionId: VERSION } }],
    ['an uppercase hash', { video: ref('D'.repeat(64)) }], ['a non-object entry', { video: TOOL }],
  ])('X02 rejects %s', (_, value) => {
    const schema = required('videoPresentationRefSchema');
    expect(schema.safeParse({ video: ref() }).success).toBe(true);
    expect(schema.safeParse(value).success).toBe(false);
  });
});
