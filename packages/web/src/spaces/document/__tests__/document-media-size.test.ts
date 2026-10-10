// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A23: the pixel size of an added picture, read off its file the
 * way the page shows it. The video path needs a real decoder and is covered by
 * the smoke suite.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { measureMediaFile } from '@web/spaces/document/document-media-size';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stands in for the browser's image loading: a picture that loads at this
 * size, or fails when no size is given.
 * @param size - The size it loads at.
 * @param size.width - Its width.
 * @param size.height - Its height.
 * @returns The object URLs handed out and taken back.
 */
function pictures(size?: { width: number; height: number }): { made: string[]; revoked: string[] } {
  const made: string[] = [];
  const revoked: string[] = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => {
      made.push(`blob:${made.length}`);
      return made[made.length - 1];
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 0;
      naturalHeight = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => {
          if (size === undefined) {
            this.onerror?.();
            return;
          }
          this.naturalWidth = size.width;
          this.naturalHeight = size.height;
          this.onload?.();
        });
      }
    },
  );
  const decode = vi.fn();
  vi.stubGlobal('createImageBitmap', decode);
  return { made, revoked };
}

describe('the size of an added file', () => {
  it('reads a picture\'s pixel size without decoding it, and lets the address go', async () => {
    const urls = pictures({ width: 640, height: 360 });

    const size = await measureMediaFile(new File(['x'], 'a.png', { type: 'image/png' }));

    expect(size).toEqual({ width: 640, height: 360 });
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(urls.revoked).toEqual(urls.made);
  });

  it('has no size for a picture the browser cannot read, and lets the address go', async () => {
    const urls = pictures();

    expect(await measureMediaFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBeUndefined();
    expect(urls.revoked).toEqual(urls.made);
  });

  it('has no size for audio', async () => {
    expect(await measureMediaFile(new File(['x'], 'a.mp3', { type: 'audio/mpeg' }))).toBeUndefined();
  });
});
