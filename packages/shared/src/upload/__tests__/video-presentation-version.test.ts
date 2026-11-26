// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The presentation identities and stored objects on the frame grid (inner#1306; frames-split design §3.2, §3.5, §4.1).
 *
 * toolInputId = sha256(canonical(sourceFingerprint, planSha256, editFileSha256)); planSha256 is the canonical plan of
 * §3.2 item 2; versionId adds policy, the producer and playback profile digests, the toolInputId, the display grid and
 * the carrier's measured bytes, never URLs, keys or the manifest. The selected P carries the grid display and the tool
 * source; the alpha manifest is the packed receipt and its rectangles. The shapes themselves are pinned in
 * `frame-grid-schema.test.ts`; this file holds the identity arithmetic and the field-level refusals. The full ledger,
 * compact table and their receipt are deleted with the frame table (§3.4).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalMiniToolValue } from '../../mini-tools/canonical-value.js';
import {
  alphaPackedManifestMatchesVersion, alphaPackedManifestSchema, alphaPackedPlanes, verifyVideoPresentationPlan, videoPresentationPlanSha256, videoPresentationRefSchema,
  videoPresentationToolInputId, videoPresentationVersionId, videoPresentationVersionSchema,
} from '../video-presentation-version.js';

const H = 'a'.repeat(64);
const VERSION = 'b'.repeat(64);
const TOOL = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const BYTES = 'e'.repeat(64);
const DIGEST = '1'.repeat(64);
type Value = Record<string, unknown>;

/**
 * Lowercase SHA-256 of a UTF-8 text.
 * @param text - The text.
 * @returns The hex digest.
 */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A copy of a value with one path set, or deleted when the value is undefined.
 * @param value - The value.
 * @param path - The path.
 * @param next - The new value.
 * @returns The copy.
 */
function patched(value: Value, path: readonly (string | number)[], next: unknown): Value {
  const copy = structuredClone(value);
  let at: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  if (next === undefined) delete at[last];
  else at[last] = next;
  return copy;
}

/**
 * A measured object receipt.
 * @param name - Its file name.
 * @param contentType - Its media type.
 * @returns The receipt.
 */
function carrier(name: string, contentType = 'video/mp4'): Value {
  return { storageKey: `video/fixture/${name}`, url: `https://assets.example.test/video/fixture/${name}`, etag: `etag-${name}`, size: 4096, sha256: BYTES, contentType };
}

/**
 * A 2 s, 30 fps grid display.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The display.
 */
function display(width = 64, height = 48): Value {
  return { width, height, fps: { numerator: 30, denominator: 1 }, frameCount: 60, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 58, leadFrames: 1, holdFrames: 2 };
}

/**
 * A native selected version whose tools read the original.
 * @returns The descriptor.
 */
function nativeVersion(): Value {
  return {
    schemaVersion: 1, sourceFingerprint: H, versionId: VERSION, toolInputId: TOOL, planSha256: PLAN, policyVersion: 1, producerVersion: DIGEST, profileVersion: DIGEST,
    original: { width: 64, height: 48, duration: 2 }, display: display(), plan: plan(),
    playback: { kind: 'native', carrier: carrier('job-1.carrier.mp4'), displayRect: null },
    toolSource: { edit: null, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false }, sourceDecodeKey: 'sdr_8bit' },
  };
}

/**
 * An alpha-packed selected version.
 * @returns The descriptor.
 */
function alphaVersion(): Value {
  return {
    ...nativeVersion(), display: display(96, 64),
    playback: { kind: 'alpha-packed', carrier: carrier('job-1.packed.mp4'), manifest: carrier('job-1.alpha.json', 'application/json') },
  };
}

/**
 * The manifest of {@link alphaVersion}.
 * @returns The manifest.
 */
function manifest(): Value {
  return { schemaVersion: 1, packed: carrier('job-1.packed.mp4'), packedWidth: 196, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 100, y: 0, width: 96, height: 64 } };
}

/**
 * A plan of §3.2 item 2.
 * @returns The plan.
 */
function plan(): Value {
  return {
    gridRulesVersion: 1,
    grid: { fps: { numerator: 30, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, leadFrames: 1, gridEnd: { numerator: 2, denominator: 1 }, singleFrameDurationMs: 5000 },
    toolSource: 'original', audioTrack: 1, display: { width: 64, height: 48 }, color: { matrix: 'bt601', toneMap: 'none' }, framePngBitDepth: 8,
  };
}

/**
 * The version input of {@link nativeVersion}.
 * @returns The input.
 */
function versionInput(): Value {
  return {
    sourceFingerprint: H, policyVersion: 1, producerVersion: DIGEST, profileVersion: DIGEST, planSha256: PLAN, toolInputId: TOOL,
    display: display(), playback: { sha256: BYTES, size: 4096, contentType: 'video/mp4' },
  };
}

describe('I §3.2 toolInputId, planSha256 and versionId', () => {
  it('I01 toolInputId is the SHA-256 of the canonical {editFileSha256, planSha256, sourceFingerprint} text', async () => {
    expect(await videoPresentationToolInputId({ sourceFingerprint: H, planSha256: PLAN, editFileSha256: null }))
      .toBe(await sha256(`{"editFileSha256":null,"planSha256":"${PLAN}","sourceFingerprint":"${H}"}`));
    expect(await videoPresentationToolInputId({ sourceFingerprint: H, planSha256: PLAN, editFileSha256: BYTES }))
      .toBe(await sha256(`{"editFileSha256":"${BYTES}","planSha256":"${PLAN}","sourceFingerprint":"${H}"}`));
  });

  it('I02 toolInputId depends on exactly the source fingerprint, the plan and the edit file (property)', async () => {
    const hex = fc.stringMatching(/^[a-f0-9]{64}$/);
    await fc.assert(fc.asyncProperty(hex, hex, fc.option(hex, { nil: null }), async (sourceFingerprint, planSha256, editFileSha256) => {
      expect(await videoPresentationToolInputId({ sourceFingerprint, planSha256, editFileSha256 }))
        .toBe(await sha256(canonicalMiniToolValue({ editFileSha256, planSha256, sourceFingerprint })));
    }), { seed: 130601, numRuns: 50 });
  });

  it.each([
    ['an uppercase fingerprint', { sourceFingerprint: 'A'.repeat(64), planSha256: PLAN, editFileSha256: null }],
    ['a short plan', { sourceFingerprint: H, planSha256: 'd'.repeat(63), editFileSha256: null }],
    ['no edit file field', { sourceFingerprint: H, planSha256: PLAN }],
    ['an extra versionId', { sourceFingerprint: H, planSha256: PLAN, editFileSha256: null, versionId: VERSION }],
  ])('I03 toolInputId rejects %s', async (_, value) => {
    await expect(videoPresentationToolInputId(value as never)).rejects.toThrow();
  });

  it('I04 planSha256 is the SHA-256 of the canonical plan and ignores key order', async () => {
    expect(await videoPresentationPlanSha256(plan())).toBe(await sha256(canonicalMiniToolValue(plan())));
    expect(await videoPresentationPlanSha256(Object.fromEntries(Object.entries(plan()).reverse()))).toBe(await videoPresentationPlanSha256(plan()));
  });

  it('I05 planSha256 changes with the grid rules, the grid, the tool source, the audio track, geometry, colour and PNG depth', async () => {
    const changes: Value[] = [
      patched(plan(), ['gridRulesVersion'], 2), patched(plan(), ['grid', 'fps'], { numerator: 30000, denominator: 1001 }),
      patched(plan(), ['grid', 'gridStart'], { numerator: 1, denominator: 100 }), patched(plan(), ['grid', 'leadFrames'], 0),
      patched(plan(), ['grid', 'gridEnd'], null), patched(plan(), ['grid', 'singleFrameDurationMs'], 1000), patched(plan(), ['toolSource'], 'edit'),
      patched(plan(), ['audioTrack'], null), patched(plan(), ['display', 'height'], 50), patched(plan(), ['color', 'matrix'], 'bt709'),
      patched(plan(), ['color', 'toneMap'], 'sdr-bt709'), patched(plan(), ['framePngBitDepth'], 16),
    ];
    const hashes = new Set([await videoPresentationPlanSha256(plan())]);
    for (const value of changes) hashes.add(await videoPresentationPlanSha256(value));
    expect(hashes.size).toBe(changes.length + 1);
  });

  it.each([
    ['a carrier encode setting', ['crf'], 18], ['a URL', ['url'], 'https://assets.example.test/x.mp4'], ['a versionId', ['versionId'], VERSION],
    ['a frame table', ['presentation'], { schemaVersion: 1, timescale: 30, runs: [] }], ['an object hash', ['editSha256'], BYTES],
  ] as const)('I06 planSha256 refuses a plan carrying %s', async (_, path, value) => {
    await expect(videoPresentationPlanSha256(plan())).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(videoPresentationPlanSha256(patched(plan(), path, value))).rejects.toThrow();
  });

  it('I07 versionId is the SHA-256 of the canonical version input', async () => {
    expect(await videoPresentationVersionId(versionInput() as never)).toBe(await sha256(canonicalMiniToolValue(versionInput())));
  });

  it.each([
    ['source fingerprint', ['sourceFingerprint'], 'b'.repeat(64)], ['policy version', ['policyVersion'], 2], ['producer version', ['producerVersion'], '2'.repeat(64)],
    ['profile version', ['profileVersion'], '2'.repeat(64)], ['plan', ['planSha256'], 'b'.repeat(64)], ['toolInputId', ['toolInputId'], 'b'.repeat(64)],
    ['display width', ['display', 'width'], 65], ['grid frame count', ['display', 'frameCount'], 61], ['carrier bytes', ['playback', 'sha256'], 'b'.repeat(64)],
    ['carrier size', ['playback', 'size'], 4097], ['carrier type', ['playback', 'contentType'], 'video/webm'],
  ] as const)('I08 versionId changes with the %s', async (_, path, value) => {
    const changed = patched(versionInput(), path, value);
    if (path[1] === 'frameCount') (changed.display as Value).holdFrames = 3;
    expect(await videoPresentationVersionId(changed as never)).not.toBe(await videoPresentationVersionId(versionInput() as never));
  });

  it.each([
    ['the carrier URL', ['playback', 'url'], 'https://assets.example.test/x.mp4'], ['the carrier storage key', ['playback', 'storageKey'], 'video/x.mp4'],
    ['the alpha manifest', ['manifest'], { sha256: BYTES, size: 300 }], ['an integer producer version', ['producerVersion'], 2],
  ] as const)('I09 versionId refuses an input carrying %s', async (_, path, value) => {
    await expect(videoPresentationVersionId(versionInput() as never)).resolves.toMatch(/^[a-f0-9]{64}$/);
    await expect(videoPresentationVersionId(patched(versionInput(), path, value) as never)).rejects.toThrow();
  });
});

describe('P §3.5 selected presentation version descriptor', () => {
  it.each([['native', nativeVersion], ['alpha-packed', alphaVersion]] as const)('P01 accepts the %s version unchanged', (_, make) => {
    expect(videoPresentationVersionSchema.parse(make())).toEqual(make());
  });

  it.each([
    ['missing versionId', ['versionId'], undefined], ['missing toolSource', ['toolSource'], undefined], ['missing playback', ['playback'], undefined],
    ['uppercase versionId', ['versionId'], 'E'.repeat(64)], ['a pending state', ['state'], 'classifying'], ['schemaVersion 2', ['schemaVersion'], 2],
    ['zero display width', ['display', 'width'], 0], ['a zero fps', ['display', 'fps'], { numerator: 0, denominator: 1 }],
    ['a string fps', ['display', 'fps'], { numerator: '30', denominator: '1' }], ['a hold that is not frameCount − V', ['display', 'holdFrames'], 1],
    ['more real frames than slots', ['display', 'realFrameCount'], 61], ['as many lead frames as real ones', ['display', 'leadFrames'], 58],
    ['a stored duration', ['display', 'duration'], 2], ['an unknown decode key', ['toolSource', 'sourceDecodeKey'], 'hdr_10bit'],
    ['a negative keyframe interval', ['toolSource', 'keyframes', 'maxKeyframeInterval'], -1],
    ['an edit file without its tier', ['toolSource', 'edit'], { ...carrier('edit.mp4'), editProfileVersion: DIGEST }],
    ['an http carrier', ['playback', 'carrier', 'url'], 'http://assets.example.test/video/fixture/job-1.carrier.mp4'],
    ['a native manifest', ['playback', 'manifest'], carrier('x.alpha.json', 'application/json')], ['a playback clock', ['playbackClock'], { schemaVersion: 1, timescale: 30, runs: [] }],
    // §3.2 item 6: P carries the plan object itself, strict as the plan schema.
    ['missing plan', ['plan'], undefined], ['a plan carrying a carrier encode setting', ['plan', 'crf'], 18], ['a plan without its colour', ['plan', 'color'], undefined],
  ] as const)('P03 rejects %s', (_, path, value) => {
    expect(videoPresentationVersionSchema.safeParse(nativeVersion()).success).toBe(true);
    expect(videoPresentationVersionSchema.safeParse(patched(nativeVersion(), path, value)).success).toBe(false);
  });

  it('P05 a native carrier padded to even records the actual picture rectangle', () => {
    const odd = { ...nativeVersion(), display: display(161, 97), playback: { kind: 'native', carrier: carrier('job-1.carrier.mp4'), displayRect: { x: 0, y: 0, width: 161, height: 97 } } };
    expect(videoPresentationVersionSchema.parse(odd)).toEqual(odd);
  });

  it('P04 an alpha-packed version carries its manifest receipt and no displayRect', () => {
    expect(videoPresentationVersionSchema.safeParse(patched(alphaVersion(), ['playback', 'manifest'], undefined)).success).toBe(false);
    expect(videoPresentationVersionSchema.safeParse(patched(alphaVersion(), ['playback', 'displayRect'], null)).success).toBe(false);
  });
});

describe('PV §3.2 item 6 a reader adopts the plan only when sha256(canonical(plan)) is planSha256', () => {
  it('PV01 a version whose planSha256 is its plan\'s digest is adopted', async () => {
    const version = { ...nativeVersion(), planSha256: await videoPresentationPlanSha256(plan()) };
    await expect(verifyVideoPresentationPlan(videoPresentationVersionSchema.parse(version))).resolves.toBeUndefined();
  });

  it.each([
    ['another digest', (value: Value): Value => ({ ...value, planSha256: PLAN })],
    ['a plan changed after the digest', (value: Value): Value => patched(value, ['plan', 'framePngBitDepth'], 16)],
    ['a plan of another colour', (value: Value): Value => patched(value, ['plan', 'color', 'toneMap'], 'sdr-bt709')],
  ] as const)('PV02 a version with %s is refused', async (_, change) => {
    const matching = { ...nativeVersion(), planSha256: await videoPresentationPlanSha256(plan()) };
    await expect(verifyVideoPresentationPlan(videoPresentationVersionSchema.parse(change(matching)))).rejects.toThrow(/plan/);
  });
});

describe('M §3.5 alpha-packed manifest', () => {
  it('M01 accepts the manifest of the alpha-packed version and matches it', () => {
    expect(alphaPackedManifestSchema.parse(manifest())).toEqual(manifest());
    expect(alphaPackedManifestMatchesVersion(manifest() as never, alphaVersion() as never)).toBe(true);
  });

  it.each([
    ['other packed bytes', ['packed', 'sha256'], 'b'.repeat(64)], ['another packed object', ['packed', 'url'], 'https://assets.example.test/video/fixture/job-2.packed.mp4'],
  ] as const)('M02 does not match a manifest with %s', (_, path, value) => {
    expect(alphaPackedManifestMatchesVersion(patched(manifest(), path, value) as never, alphaVersion() as never)).toBe(false);
  });

  it('M02 does not match a version whose display differs from the rectangles, nor a native version', () => {
    expect(alphaPackedManifestMatchesVersion(manifest() as never, { ...alphaVersion(), display: display(64, 48) } as never)).toBe(false);
    expect(alphaPackedManifestMatchesVersion(manifest() as never, { ...nativeVersion(), display: display(96, 64) } as never)).toBe(false);
  });

  it.each([
    ['overlapping rectangles', patched(manifest(), ['alphaRect', 'x'], 0)],
    ['a rectangle outside the packed frame', patched(manifest(), ['packedHeight'], 63)],
    ['unequal colour and alpha sizes', patched(manifest(), ['alphaRect', 'width'], 48)],
    ['a versionId', patched(manifest(), ['versionId'], VERSION)], ['schemaVersion 2', patched(manifest(), ['schemaVersion'], 2)],
    ['an http packed object', patched(manifest(), ['packed', 'url'], 'http://assets.example.test/video/fixture/job-1.packed.mp4')],
  ])('M03 rejects %s', (_, value) => {
    expect(alphaPackedManifestSchema.safeParse(manifest()).success).toBe(true);
    expect(alphaPackedManifestSchema.safeParse(value).success).toBe(false);
  });
});

describe('MG §3.5, §8.2 the manifest rectangles are the packed carrier\'s own planes, scaled like any carrier', () => {
  /**
   * A manifest of the given planes over the alpha version's packed carrier.
   * @param planes - The packed size and the two rectangles.
   * @returns The manifest.
   */
  const over = (planes: Value): Value => ({ schemaVersion: 1, packed: carrier('job-1.packed.mp4'), ...planes });
  /**
   * An alpha-packed version of the given display size.
   * @param width - Display width.
   * @param height - Display height.
   * @returns The version.
   */
  const alphaOf = (width: number, height: number): Value => ({ ...alphaVersion(), display: display(width, height) });
  const uhd = { packedWidth: 3844, packedHeight: 1080, colorRect: { x: 0, y: 0, width: 1920, height: 1080 }, alphaRect: { x: 1924, y: 0, width: 1920, height: 1080 } };

  it.each([
    ['a 3840x2160 display', 3840, 2160, uhd],
    ['a 1440x1440 display', 1440, 1440, { packedWidth: 2164, packedHeight: 1080, colorRect: { x: 0, y: 0, width: 1080, height: 1080 }, alphaRect: { x: 1084, y: 0, width: 1080, height: 1080 } }],
    ['an odd 97x65 display, padded and unscaled', 97, 65, { packedWidth: 200, packedHeight: 66, colorRect: { x: 0, y: 0, width: 97, height: 65 }, alphaRect: { x: 102, y: 0, width: 97, height: 65 } }],
  ] as const)('MG01 the planes of %s under the 1080 cap', (_, width, height, planes) => {
    expect(alphaPackedManifestMatchesVersion(over(planes) as never, alphaOf(width, height) as never)).toBe(true);
    expect(alphaPackedPlanes({ width, height }, 1080)).toEqual(planes);
  });

  it.each([
    ['display-size rectangles in a 1080 carrier', { ...uhd, colorRect: { x: 0, y: 0, width: 3840, height: 2160 }, alphaRect: { x: 1924, y: 0, width: 3840, height: 2160 } }],
    ['planes of another aspect', { ...uhd, colorRect: { x: 0, y: 0, width: 1920, height: 1000 }, alphaRect: { x: 1924, y: 0, width: 1920, height: 1000 } }],
    ['a packed width without the plane gap', { ...uhd, packedWidth: 3840, alphaRect: { x: 1920, y: 0, width: 1920, height: 1080 } }],
    ['an alpha plane off the gap', { ...uhd, alphaRect: { x: 1922, y: 0, width: 1920, height: 1080 } }],
    ['a packed height past the plane', { ...uhd, packedHeight: 1088 }],
  ] as const)('MG02 a 3840x2160 alpha version refuses %s', (_, planes) => {
    expect(alphaPackedManifestMatchesVersion(over(planes) as never, alphaOf(3840, 2160) as never)).toBe(false);
  });
});

describe('X §3.5 accepted execution presentationRef map', () => {
  const ref = (planSha256 = PLAN): { toolInputId: string; planSha256: string } => ({ toolInputId: TOOL, planSha256 });

  it.each([['one input', { video: ref() }], ['two transition inputs', { 'clip-a': ref(), 'clip-b': { toolInputId: 'b'.repeat(64), planSha256: 'b'.repeat(64) } }]])('X01 accepts %s', (_, value) => {
    expect(videoPresentationRefSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['an empty map', {}], ['an empty input id', { '': ref() }], ['a missing planSha256', { video: { toolInputId: TOOL } }],
    ['a versionId in the entry', { video: { ...ref(), versionId: VERSION } }], ['an uppercase hash', { video: ref('D'.repeat(64)) }],
  ])('X02 rejects %s', (_, value) => {
    expect(videoPresentationRefSchema.safeParse({ video: ref() }).success).toBe(true);
    expect(videoPresentationRefSchema.safeParse(value).success).toBe(false);
  });
});
