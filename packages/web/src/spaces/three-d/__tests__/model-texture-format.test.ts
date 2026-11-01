// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectTextureFormatSupport } from '@web/spaces/three-d/model-texture-format';

describe('texture format support (inner#1690)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports the formats whose GLTFLoader probe image decodes to a 1-pixel image', async () => {
    const requested: string[] = [];
    vi.stubGlobal('Image', class {
      height = 0;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      /** Decode the probe the way a browser without AVIF support does. */
      set src(value: string) {
        requested.push(value.slice(0, 15));
        queueMicrotask(() => {
          if (value.startsWith('data:image/webp')) { this.height = 1; this.onload?.(); } else this.onerror?.();
        });
      }
    });
    await expect(detectTextureFormatSupport()).resolves.toEqual({ webp: true, avif: false });
    expect(requested.sort()).toEqual(['data:image/avif', 'data:image/webp']);
  });
});
