// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §64.4 SC01 and SC07 (frames-split design §3.2, §3.5, §4.1, §7.4): one strict shape per object.
 * The P descriptor's display is the decoded first frame's geometry plus the frame grid (fps, measured frameCount, grid
 * start, real frame count, lead and hold frames); the bundle carries the tool source (edit-file receipt or null, source keyframe
 * statistics, sourceDecodeKey); the playback file is the grid, so there is no playback clock, frame table or origin
 * mapping. producer and profile versions are sha256 digests. The alpha manifest has no versionId or policyVersion.
 * toolInputId binds the edit file's bytes.
 */

import { describe, expect, it } from 'vitest';
import * as versionModule from '../video-presentation-version.js';
import {
  alphaPackedManifestSchema,
  videoPresentationToolInputId,
  videoPresentationVersionId,
  videoPresentationVersionSchema,
} from '../video-presentation-version.js';
import type { FrameRate } from '../frame-grid-rate.js';

const SOURCE = 'a'.repeat(64);
const VERSION = 'b'.repeat(64);
const TOOL = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const BYTES = 'e'.repeat(64);
const PRODUCER = '1'.repeat(64);
const PROFILE = '2'.repeat(64);
const EDIT_PROFILE = '3'.repeat(64);
const EDIT_BYTES = '4'.repeat(64);

interface ObjectReceipt { storageKey: string; url: string; etag: string; size: number; sha256: string; contentType: string }

/**
 * A measured object receipt.
 * @param name - The object's name.
 * @param contentType - Its media type.
 * @returns A fresh receipt.
 */
function receipt(name: string, contentType = 'video/mp4'): ObjectReceipt {
  return { storageKey: `video/fixture/${name}`, url: `https://assets.example.test/video/fixture/${name}`, etag: `etag-${name}`, size: 4096, sha256: BYTES, contentType };
}

const fps30: FrameRate = { numerator: 30, denominator: 1 };

/**
 * The display of a 2-second 30 fps grid on a 64x48 decoded first frame.
 * @returns A fresh display.
 */
function display(): Record<string, unknown> {
  return { width: 64, height: 48, fps: fps30, frameCount: 60, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 60, leadFrames: 0, holdFrames: 0 };
}

/**
 * The tool source of a version whose tools read the original (no edit file).
 * @returns A fresh tool source.
 */
function originalToolSource(): Record<string, unknown> {
  return {
    edit: null,
    keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false },
    sourceDecodeKey: 'sdr_8bit',
  };
}

/**
 * A native selected version in the §3.5 shape.
 * @returns A fresh descriptor.
 */
function gridVersion(): Record<string, unknown> {
  return {
    schemaVersion: 1, sourceFingerprint: SOURCE, versionId: VERSION, toolInputId: TOOL, planSha256: PLAN, policyVersion: 1,
    producerVersion: PRODUCER, profileVersion: PROFILE,
    original: { width: 64, height: 48, duration: 2 },
    display: display(),
    playback: { kind: 'native', carrier: receipt('playback.mp4'), displayRect: null },
    toolSource: originalToolSource(),
  };
}

/**
 * A version in the shape the branch wrote before the grid: a playback clock frame table and integer versions.
 * @returns A fresh old descriptor.
 */
function clockVersion(): Record<string, unknown> {
  return {
    schemaVersion: 1, sourceFingerprint: SOURCE, versionId: VERSION, toolInputId: TOOL, planSha256: PLAN, policyVersion: 1, producerVersion: 2, profileVersion: 1,
    original: { width: 64, height: 48, duration: 2.125 }, display: { width: 64, height: 48, duration: { numerator: '17', denominator: '8' } },
    playback: { kind: 'native', carrier: receipt('original.mp4'), displayRect: null },
    playbackClock: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
  };
}

describe('SC01: the P descriptor, tool source and source keyframe statistics have only the §3.5 shape', () => {
  it('SC01: a ready bundle with the grid display, sha256 versions and the tool source parses', () => {
    expect(videoPresentationVersionSchema.safeParse(gridVersion()).success).toBe(true);
  });

  it('SC01: a bundle whose tools read an edit file carries its receipt, profile version and tier', () => {
    const version = gridVersion();
    version.toolSource = {
      edit: { ...receipt('edit.mp4'), sha256: EDIT_BYTES, editProfileVersion: EDIT_PROFILE, tier: 'edit_h264_intra_8bit_420' },
      keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 0, allKeyframes: true },
      sourceDecodeKey: 'sdr_prores',
    };
    expect(videoPresentationVersionSchema.safeParse(version).success).toBe(true);
  });

  it('SC01: the old shape with a playback clock frame table and integer versions fails to parse', () => {
    expect(videoPresentationVersionSchema.safeParse(clockVersion()).success).toBe(false);
  });

  it('SC01: a grid version that still carries a playback clock fails to parse', () => {
    // The rejection below only means something once the §3.5 shape itself is accepted.
    expect(videoPresentationVersionSchema.safeParse(gridVersion()).success).toBe(true);
    const version = { ...gridVersion(), playbackClock: { schemaVersion: 1, timescale: 30, runs: [{ start: 0, count: 60, step: 1, duration: 1 }] } };
    expect(videoPresentationVersionSchema.safeParse(version).success).toBe(false);
  });

  it('SC01: integer producer or profile versions fail to parse (they are sha256 digests)', () => {
    // The rejection below only means something once the §3.5 shape itself is accepted.
    expect(videoPresentationVersionSchema.safeParse(gridVersion()).success).toBe(true);
    expect(videoPresentationVersionSchema.safeParse({ ...gridVersion(), producerVersion: 2 }).success).toBe(false);
    expect(videoPresentationVersionSchema.safeParse({ ...gridVersion(), profileVersion: 1 }).success).toBe(false);
  });

  it('SC01: a bundle without the tool source fails to parse', () => {
    // The rejection below only means something once the §3.5 shape itself is accepted.
    expect(videoPresentationVersionSchema.safeParse(gridVersion()).success).toBe(true);
    const version = gridVersion();
    delete version.toolSource;
    expect(videoPresentationVersionSchema.safeParse(version).success).toBe(false);
  });

  it('SC01: the frame-table objects (full ledger, compact table, ledger receipt) and their plan are gone', () => {
    const exported = Object.keys(versionModule);
    for (const removed of [
      'videoPresentationLedgerSchema', 'videoPresentationLedgerReceiptSchema', 'videoPresentationCompactSchema',
      'videoPresentationLedgerEncodingSchema', 'projectVideoPresentationCompact', 'videoPresentationKeyframeFlags',
    ]) expect(exported).not.toContain(removed);
  });

  it('SC01: the alpha manifest is the packed receipt and the logical rectangles, without versionId or policyVersion', () => {
    const manifest = {
      schemaVersion: 1, packed: receipt('packed.mp4'), packedWidth: 132, packedHeight: 48,
      colorRect: { x: 0, y: 0, width: 64, height: 48 }, alphaRect: { x: 68, y: 0, width: 64, height: 48 },
    };
    expect(alphaPackedManifestSchema.safeParse(manifest).success).toBe(true);
    expect(alphaPackedManifestSchema.safeParse({ ...manifest, versionId: VERSION }).success).toBe(false);
    expect(alphaPackedManifestSchema.safeParse({ ...manifest, policyVersion: 1 }).success).toBe(false);
  });

  it('SC01: toolInputId binds the edit file bytes: null without one, and a different edit file gives a different id', async () => {
    const without = await videoPresentationToolInputId({ sourceFingerprint: SOURCE, planSha256: PLAN, editFileSha256: null } as never);
    const withEdit = await videoPresentationToolInputId({ sourceFingerprint: SOURCE, planSha256: PLAN, editFileSha256: EDIT_BYTES } as never);
    const otherEdit = await videoPresentationToolInputId({ sourceFingerprint: SOURCE, planSha256: PLAN, editFileSha256: BYTES } as never);
    expect(new Set([without, withEdit, otherEdit]).size).toBe(3);
  });

  it('SC01: versionId takes sha256 producer and profile versions and the toolInputId', async () => {
    const input = {
      sourceFingerprint: SOURCE, policyVersion: 1, producerVersion: PRODUCER, profileVersion: PROFILE, planSha256: PLAN, toolInputId: TOOL,
      display: display(), playback: { sha256: BYTES, size: 4096, contentType: 'video/mp4' },
    };
    const first = await videoPresentationVersionId(input as never);
    const otherTool = await videoPresentationVersionId({ ...input, toolInputId: 'f'.repeat(64) } as never);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(otherTool).not.toBe(first);
  });
});

describe('SC07: P.display is the decoded first frame with the grid; the presentation has no container crop', () => {
  it('SC07: display carries the decoded first frame width and height beside the grid', () => {
    const parsed = videoPresentationVersionSchema.parse(gridVersion()) as unknown as { display: Record<string, unknown> };
    expect(parsed.display).toMatchObject({ width: 64, height: 48, fps: fps30, frameCount: 60, realFrameCount: 60 });
  });

  it('SC07: display has no stored duration (it is frameCount / fps)', () => {
    // The rejection below only means something once the §3.5 shape itself is accepted.
    expect(videoPresentationVersionSchema.safeParse(gridVersion()).success).toBe(true);
    const withDuration = { ...gridVersion(), display: { ...display(), duration: { numerator: 2, denominator: 1 } } };
    expect(videoPresentationVersionSchema.safeParse(withDuration).success).toBe(false);
  });

  it('SC07: container-crop and natural-size fields are rejected', () => {
    // The rejection below only means something once the §3.5 shape itself is accepted.
    expect(videoPresentationVersionSchema.safeParse(gridVersion()).success).toBe(true);
    for (const extra of [{ crop: { x: 0, y: 0, width: 60, height: 44 } }, { containerCrop: { top: 2, bottom: 2, left: 2, right: 2 } }, { naturalSize: { width: 60, height: 44 } }]) {
      expect(videoPresentationVersionSchema.safeParse({ ...gridVersion(), display: { ...display(), ...extra } }).success).toBe(false);
      expect(videoPresentationVersionSchema.safeParse({ ...gridVersion(), ...extra }).success).toBe(false);
    }
  });
});
