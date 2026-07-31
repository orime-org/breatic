// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The decisions the avatar pipeline makes before and after the browser does
 * the actual raster work.
 *
 * Drawing and decoding are browser APIs that jsdom cannot run, so they stay
 * out of here and are covered by the real-browser smoke. What IS covered is
 * every branch that decides something: the two input gates, and the
 * encode-format fallback — which matters precisely because a real browser
 * almost never takes it (they all support WebP), so a smoke run would leave
 * it unexercised and a mistake there ships as a broken image.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AVATAR_OUTPUT_PX,
  AVATAR_OUTPUT_QUALITY,
  MAX_AVATAR_INPUT_BYTES,
  MAX_AVATAR_INPUT_EDGE_PX,
  checkAvatarFile,
  checkAvatarPixels,
  encodeAvatarBlob,
} from '@web/pages/studio/container/dialogs/avatar-image';

describe('checkAvatarFile', () => {
  it('accepts a normal photo', () => {
    expect(checkAvatarFile({ size: 3 * 1024 * 1024 })).toBeNull();
  });

  it('accepts a file exactly on the cap', () => {
    expect(checkAvatarFile({ size: MAX_AVATAR_INPUT_BYTES })).toBeNull();
  });

  it('rejects one byte over the cap', () => {
    expect(checkAvatarFile({ size: MAX_AVATAR_INPUT_BYTES + 1 })).toBe(
      'too_large',
    );
  });

  it('rejects an empty file', () => {
    expect(checkAvatarFile({ size: 0 })).toBe('empty');
  });

  it('caps at 20 MiB — big enough for any real photo, small enough to catch a video picked by mistake', () => {
    expect(MAX_AVATAR_INPUT_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('checkAvatarPixels', () => {
  it('accepts an ordinary camera image', () => {
    expect(checkAvatarPixels(6000, 4000)).toBeNull();
  });

  it('accepts an image exactly on the edge limit', () => {
    expect(
      checkAvatarPixels(MAX_AVATAR_INPUT_EDGE_PX, MAX_AVATAR_INPUT_EDGE_PX),
    ).toBeNull();
  });

  it('rejects an over-long width even when the height is small', () => {
    expect(checkAvatarPixels(MAX_AVATAR_INPUT_EDGE_PX + 1, 100)).toBe(
      'too_many_pixels',
    );
  });

  it('rejects an over-long height even when the width is small', () => {
    expect(checkAvatarPixels(100, MAX_AVATAR_INPUT_EDGE_PX + 1)).toBe(
      'too_many_pixels',
    );
  });

  it('rejects an image that decoded to nothing', () => {
    expect(checkAvatarPixels(0, 0)).toBe('not_an_image');
  });
});

describe('encodeAvatarBlob', () => {
  /**
   * A stand-in for `canvas.toBlob` that answers with whatever type the
   * caller's browser would really produce.
   * @param produced - The MIME type each requested type actually comes back as.
   * @returns The stub encoder plus the calls it recorded.
   */
  function encoderProducing(
    produced: Record<string, string | null>,
  ): {
    encode: (type: string, quality: number) => Promise<Blob | null>;
    calls: Array<{ type: string; quality: number }>;
  } {
    const calls: Array<{ type: string; quality: number }> = [];
    const encode = vi.fn(
      async (type: string, quality: number): Promise<Blob | null> => {
        calls.push({ type, quality });
        const actual = produced[type];
        if (actual === undefined || actual === null) return null;
        return new Blob(['x'], { type: actual });
      },
    );
    return { encode, calls };
  }

  it('returns the WebP when the browser really encodes WebP', async () => {
    const { encode, calls } = encoderProducing({ 'image/webp': 'image/webp' });

    const blob = await encodeAvatarBlob(encode);

    expect(blob.type).toBe('image/webp');
    expect(calls).toEqual([
      { type: 'image/webp', quality: AVATAR_OUTPUT_QUALITY },
    ]);
  });

  it('re-encodes as JPEG when the browser silently falls back to PNG', async () => {
    // `toBlob` does not report an unsupported type — it quietly hands back a
    // PNG. Trusting the requested type would ship a PNG under a .webp name,
    // and the browser decodes by declared type, so it would render broken.
    const { encode, calls } = encoderProducing({
      'image/webp': 'image/png',
      'image/jpeg': 'image/jpeg',
    });

    const blob = await encodeAvatarBlob(encode);

    expect(blob.type).toBe('image/jpeg');
    expect(calls.map((c) => c.type)).toEqual(['image/webp', 'image/jpeg']);
  });

  it('accepts whatever the second attempt produced rather than looping', async () => {
    // A browser that supports neither is hypothetical, but retrying forever
    // would hang the dialog. PNG is a format the server accepts anyway, so
    // the worst case is a larger upload, not a failure.
    const { encode, calls } = encoderProducing({
      'image/webp': 'image/png',
      'image/jpeg': 'image/png',
    });

    const blob = await encodeAvatarBlob(encode);

    expect(blob.type).toBe('image/png');
    expect(calls).toHaveLength(2);
  });

  it('throws when the canvas produces nothing at all', async () => {
    const { encode } = encoderProducing({ 'image/webp': null });

    await expect(encodeAvatarBlob(encode)).rejects.toThrow();
  });

  it('throws when the fallback attempt also produces nothing', async () => {
    const { encode } = encoderProducing({
      'image/webp': 'image/png',
      'image/jpeg': null,
    });

    await expect(encodeAvatarBlob(encode)).rejects.toThrow();
  });

  it('outputs 512px square at quality 0.9', () => {
    expect(AVATAR_OUTPUT_PX).toBe(512);
    expect(AVATAR_OUTPUT_QUALITY).toBe(0.9);
  });
});
