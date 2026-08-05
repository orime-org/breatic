// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The decisions the avatar pipeline makes before and after the browser does
 * the actual raster work.
 *
 * Drawing and decoding are browser APIs that jsdom cannot run, so they stay
 * out of here and are covered by the real-browser smoke. What IS covered is
 * every branch that decides something: the two input gates, and the encode
 * step — which is now a single request for PNG, so what these tests pin is
 * mostly that it STAYS single. A reintroduced format negotiation would be
 * invisible in a smoke run (the picture would look identical) and would only
 * surface as avatars stored under a format nobody expects.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  AVATAR_OUTPUT_PX,
  AVATAR_OUTPUT_TYPE,
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
   * @returns The stub encoder plus the types it was asked for.
   */
  function encoderProducing(produced: Record<string, string | null>): {
    encode: (type: string) => Promise<Blob | null>;
    calls: string[];
  } {
    const calls: string[] = [];
    const encode = vi.fn(async (type: string): Promise<Blob | null> => {
      calls.push(type);
      const actual = produced[type];
      if (actual === undefined || actual === null) return null;
      return new Blob(['x'], { type: actual });
    });
    return { encode, calls };
  }

  it('asks for PNG once and ships what came back', async () => {
    // The `calls` assertion is doing two jobs: PNG came back, and nothing was
    // asked for twice. There is no fallback to test because PNG is what
    // `toBlob` falls back TO when it cannot honour a type — so it is the one
    // request that cannot come back as something else, and a second encode
    // would only be a slower way to get the same bytes.
    const { encode, calls } = encoderProducing({ 'image/png': 'image/png' });

    const blob = await encodeAvatarBlob(encode);

    expect(blob.type).toBe('image/png');
    expect(calls).toEqual(['image/png']);
  });

  it('passes no quality argument, because PNG has none', async () => {
    // `toBlob` consults quality only for lossy types. Passing one here would
    // read as a knob that does something.
    const { encode } = encoderProducing({ 'image/png': 'image/png' });

    await encodeAvatarBlob(encode);

    expect(encode).toHaveBeenCalledWith('image/png');
  });

  it('throws when the canvas produces nothing at all', async () => {
    // A tainted or out-of-memory canvas, which no retry fixes.
    const { encode } = encoderProducing({ 'image/png': null });

    await expect(encodeAvatarBlob(encode)).rejects.toThrow();
  });

});

describe('the two output constants', () => {
  it('pins both, because each breaks something this file cannot see', () => {
    // Not a behaviour assertion, and the name should not suggest one:
    // `renderAvatarBlob` is where a 512 square is actually produced, and it
    // needs a canvas jsdom does not have. What these two lines guard is that
    // neither number moves silently.
    //
    // AVATAR_OUTPUT_PX — `avatar.max_bytes` in config/storage.yaml is sized
    // against the incompressible worst case AT this resolution, which scales
    // with the pixel count. Raising this without raising that cap starts
    // refusing legitimate crops of detailed pictures.
    //
    // AVATAR_OUTPUT_TYPE — this one IS a cross-package contract, unlike the
    // size. The server's accepted-type table holds exactly `image/png`, keyed
    // on what the uploaded bytes sniff as, so changing this to WebP refuses
    // every upload with a 415: not for being too large, but for having no
    // extension to be stored under.
    expect(AVATAR_OUTPUT_PX).toBe(512);
    expect(AVATAR_OUTPUT_TYPE).toBe('image/png');
  });
});
