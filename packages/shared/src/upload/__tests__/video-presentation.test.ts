// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { alphaManifestMatchesPresentation, alphaManifestSchema, alphaManifestKeyFor, alphaPackedKeyFor, parseVideoPresentation, videoPresentationKeyFor, videoPresentationSchema } from '../video-presentation.js';

// Reviewed contract fixtures for inner#1306.
const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const key = 'video/fixture/original.webm';
const baseURL = `https://assets.test.invalid/${key}`;
const base = { schemaVersion: 1 as const, sourceFingerprint: H, original: { width: 96, height: 64, duration: 1 } };
const attempt = { jobId: `alpha:${H}`, deadlineAt: 7201000 };
const native = { ...base, state: 'native' as const };
const alpha = { ...base, state: 'alpha_ready' as const, alpha: { manifestURL: `${baseURL}.alpha.v1.json` } };
const manifest = { schemaVersion: 1 as const, sourceFingerprint: H, packedURL: `${baseURL}.alpha.v1.mp4`, packedWidth: 192, packedHeight: 64, colorRect: { x: 0, y: 0, width: 96, height: 64 }, alphaRect: { x: 96, y: 0, width: 96, height: 64 } };

describe('owned video presentation descriptor', () => {
  it('derives sidecars from the canonical registered key', () => {
    expect(videoPresentationKeyFor(key)).toBe('video/fixture/original.webm.video-presentation.v1.json');
    expect(alphaPackedKeyFor(key)).toBe('video/fixture/original.webm.alpha.v1.mp4');
    expect(alphaManifestKeyFor(key)).toBe('video/fixture/original.webm.alpha.v1.json');
  });
  it.each([native, alpha, { ...base, state: 'classifying', attempt }, { ...base, state: 'alpha_pending', attempt }, { ...base, state: 'failed', error: 'expired', attempt }])('accepts the independent $state descriptor', (value) => {
    expect(videoPresentationSchema.parse(value)).toEqual(value);
    expect(parseVideoPresentation(value, H)).toEqual(value);
  });
  it.each([undefined, null, { ...native, schemaVersion: 2 }, { ...native, sourceFingerprint: H2 }])('keeps missing, obsolete and other-source descriptors unknown', (value) => {
    expect(parseVideoPresentation(value, H)).toBeNull();
  });
  it.each(['A'.repeat(64), 'abc', 'g'.repeat(64)])('rejects noncanonical SHA256 %s', (sourceFingerprint) => {
    expect(videoPresentationSchema.safeParse({ ...native, sourceFingerprint }).success).toBe(false);
    expect(alphaManifestSchema.safeParse({ ...manifest, sourceFingerprint }).success).toBe(false);
  });
  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects invalid original pixel size %s', (width) => {
    expect(videoPresentationSchema.safeParse({ ...native, original: { ...base.original, width } }).success).toBe(false);
    expect(videoPresentationSchema.safeParse({ ...native, original: { ...base.original, height: width } }).success).toBe(false);
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid original duration %s', (duration) => {
    expect(videoPresentationSchema.safeParse({ ...native, original: { ...base.original, duration } }).success).toBe(false);
  });
  it.each([{ ...base, state: 'alpha_ready' }, { ...base, state: 'failed' }, { ...base, state: 'classifying' }, { ...base, state: 'alpha_pending', attempt: { jobId: '' } }, { ...native, error: 'expired' }, { ...alpha, error: 'expired' }])('rejects internally inconsistent state $state', (value) => {
    expect(videoPresentationSchema.safeParse(value).success).toBe(false);
  });
  it('rejects renderer config inside the owned descriptor', () => {
    expect(videoPresentationSchema.safeParse({ ...native, config: { info: { v: 2 } } }).success).toBe(false);
  });
});

describe('owned alpha geometry', () => {
  it('accepts the matching manifest without rewriting canonical media', () => {
    expect(alphaManifestSchema.parse(manifest)).toEqual(manifest);
    expect(alphaManifestMatchesPresentation(manifest, alpha)).toBe(true);
    expect(alphaManifestMatchesPresentation({ ...manifest, sourceFingerprint: H2 }, alpha)).toBe(false);
  });
  it.each([
    { ...manifest, colorRect: { ...manifest.colorRect, x: -1 } },
    { ...manifest, colorRect: { ...manifest.colorRect, x: 1 } },
    { ...manifest, alphaRect: { ...manifest.alphaRect, x: 97 } },
    { ...manifest, colorRect: { ...manifest.colorRect, width: 0 } },
    { ...manifest, colorRect: { ...manifest.colorRect, height: 1.5 } },
    { ...manifest, alphaRect: { ...manifest.alphaRect, width: 48 } },
    { ...manifest, alphaRect: { ...manifest.alphaRect, x: 0 } },
    { ...manifest, packedHeight: 63 },
  ])('rejects invalid or overlapping geometry', (value) => {
    expect(alphaManifestSchema.safeParse(value).success).toBe(false);
  });
  it('rejects otherwise valid geometry that does not present the original dimensions', () => {
    const smaller = { ...manifest, colorRect: { x: 0, y: 0, width: 48, height: 32 }, alphaRect: { x: 96, y: 0, width: 48, height: 32 } };
    expect(alphaManifestSchema.safeParse(smaller).success).toBe(true);
    expect(alphaManifestMatchesPresentation(smaller, alpha)).toBe(false);
  });
  it('allows encoding alignment padding for an odd original size', () => {
    const odd = { ...manifest, colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 } };
    const descriptor = { ...alpha, original: { width: 95, height: 63, duration: 1 } };
    expect(alphaManifestSchema.parse(odd)).toEqual(odd);
    expect(alphaManifestMatchesPresentation(odd, descriptor)).toBe(true);
  });
});
