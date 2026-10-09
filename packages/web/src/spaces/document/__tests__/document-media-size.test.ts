// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A23: the pixel size of an added picture, read off its file.
 * The video path needs a real decoder and is covered by the smoke suite.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { measureMediaFile } from '@web/spaces/document/document-media-size';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the size of an added file', () => {
  it('reads a picture\'s pixel size and lets the decoded copy go', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve({ width: 640, height: 360, close })));

    const size = await measureMediaFile(new File(['x'], 'a.png', { type: 'image/png' }));

    expect(size).toEqual({ width: 640, height: 360 });
    expect(close).toHaveBeenCalled();
  });

  it('has no size for a picture the browser cannot decode', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('cannot decode'))));

    expect(await measureMediaFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBeUndefined();
  });

  it('has no size for audio', async () => {
    expect(await measureMediaFile(new File(['x'], 'a.mp3', { type: 'audio/mpeg' }))).toBeUndefined();
  });
});
