// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The decisions the crop pipeline makes before and after the browser does the
 * actual raster work, for both pictures it produces: a studio avatar and a
 * project cover.
 *
 * Drawing and decoding are browser APIs that jsdom cannot run, so they stay
 * out of here and are covered by the real-browser smoke. What IS covered is
 * every branch that decides something: the two input gates, and the encode
 * step, which asks once for the output's format and refuses anything else.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AVATAR_OUTPUT,
  COVER_OUTPUT,
  MAX_PICKED_BYTES,
  MAX_PICKED_EDGE_PX,
  checkPickedFile,
  checkPickedPixels,
  encodeCropBlob,
} from '@web/pages/studio/container/dialogs/crop-image';

describe('checkPickedFile', () => {
  it('accepts a normal photo', () => {
    expect(checkPickedFile({ size: 3 * 1024 * 1024 })).toBeNull();
  });

  it('accepts a file exactly on the cap', () => {
    expect(checkPickedFile({ size: MAX_PICKED_BYTES })).toBeNull();
  });

  it('rejects one byte over the cap', () => {
    expect(checkPickedFile({ size: MAX_PICKED_BYTES + 1 })).toBe('too_large');
  });

  it('rejects an empty file', () => {
    expect(checkPickedFile({ size: 0 })).toBe('empty');
  });

  it('caps at 20 MiB — big enough for any real photo, small enough to catch a video picked by mistake', () => {
    expect(MAX_PICKED_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('checkPickedPixels', () => {
  it('accepts an ordinary camera image', () => {
    expect(checkPickedPixels(6000, 4000)).toBeNull();
  });

  it('accepts an image exactly on the edge limit', () => {
    expect(checkPickedPixels(MAX_PICKED_EDGE_PX, MAX_PICKED_EDGE_PX)).toBeNull();
  });

  it('rejects an over-long width even when the height is small', () => {
    expect(checkPickedPixels(MAX_PICKED_EDGE_PX + 1, 100)).toBe('too_many_pixels');
  });

  it('rejects an over-long height even when the width is small', () => {
    expect(checkPickedPixels(100, MAX_PICKED_EDGE_PX + 1)).toBe('too_many_pixels');
  });

  it('rejects an image that decoded to nothing', () => {
    expect(checkPickedPixels(0, 0)).toBe('not_an_image');
  });
});

describe('encodeCropBlob', () => {
  /**
   * A stand-in for `canvas.toBlob` that answers with whatever type the
   * caller's browser would really produce.
   * @param produced - The MIME type each requested type actually comes back as.
   * @returns The stub encoder.
   */
  function encoderProducing(
    produced: Record<string, string | null>,
  ): (type: string, quality?: number) => Promise<Blob | null> {
    return vi.fn(async (type: string): Promise<Blob | null> => {
      const actual = produced[type];
      if (actual === undefined || actual === null) return null;
      return new Blob(['x'], { type: actual });
    });
  }

  it('encodes an avatar as PNG, with no quality argument', async () => {
    const encode = encoderProducing({ 'image/png': 'image/png' });

    const blob = await encodeCropBlob(encode, AVATAR_OUTPUT);

    expect(blob.type).toBe('image/png');
    expect(encode).toHaveBeenCalledExactlyOnceWith('image/png', undefined);
  });

  it('encodes a cover as JPEG at its quality', async () => {
    const encode = encoderProducing({ 'image/jpeg': 'image/jpeg' });

    const blob = await encodeCropBlob(encode, COVER_OUTPUT);

    expect(blob.type).toBe('image/jpeg');
    expect(encode).toHaveBeenCalledExactlyOnceWith('image/jpeg', COVER_OUTPUT.quality);
  });

  it('refuses a result in another format than the one asked for', async () => {
    // `toBlob` answers a type it cannot produce with a PNG instead of failing.
    const encode = encoderProducing({ 'image/jpeg': 'image/png' });

    await expect(encodeCropBlob(encode, COVER_OUTPUT)).rejects.toThrow();
  });

  it('throws when the canvas produces nothing at all', async () => {
    // A tainted or out-of-memory canvas, which no retry fixes.
    const encode = encoderProducing({ 'image/png': null });

    await expect(encodeCropBlob(encode, AVATAR_OUTPUT)).rejects.toThrow();
  });
});

describe('the two outputs', () => {
  it('produces a 512 PNG square for an avatar and an 800×450 JPEG for a cover', () => {
    // The cover is sized to the card: a grid column never grows past ~392 CSS
    // px, so 800 wide covers a 2x screen.
    expect(AVATAR_OUTPUT).toEqual({ width: 512, height: 512, type: 'image/png' });
    expect(COVER_OUTPUT).toEqual({
      width: 800,
      height: 450,
      type: 'image/jpeg',
      quality: 0.85,
    });
  });
});
