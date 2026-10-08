// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreviewFailures, usePreviewSrc, usePreviewWidth } from '@web/lib/preview-src';

const UUID = '18f58aed-b802-4243-a8ea-02d377de9679';
const STORED = `https://resource-dev.breatic.cc/image/2026-09-30/1_${UUID}.png`;
const PREVIEW = `${STORED}.preview.webp`;

beforeEach(() => {
  resetPreviewFailures();
});

describe('usePreviewSrc', () => {
  it('gives the preview of a stored image', () => {
    const { result } = renderHook(() => usePreviewSrc(STORED));

    expect(result.current.src).toBe(PREVIEW);
    expect(result.current.isOriginal).toBe(false);
  });

  it('gives an external image as it is', () => {
    const external = 'https://images.example.com/a.png';
    const { result } = renderHook(() => usePreviewSrc(external));

    expect(result.current.src).toBe(external);
    expect(result.current.isOriginal).toBe(true);
  });

  it('gives the original when the preview is not wanted', () => {
    const { result } = renderHook(() => usePreviewSrc(STORED, { enabled: false }));

    expect(result.current.src).toBe(STORED);
    expect(result.current.isOriginal).toBe(true);
  });

  it('gives nothing for no address', () => {
    const { result } = renderHook(() => usePreviewSrc(null));

    expect(result.current.src).toBeNull();
  });

  it('falls back to the original once the preview fails to load', () => {
    const { result } = renderHook(() => usePreviewSrc(STORED));

    act(() => result.current.onError());

    expect(result.current.src).toBe(STORED);
    expect(result.current.isOriginal).toBe(true);
  });

  it('shares a failure with every other place showing the same image', () => {
    const first = renderHook(() => usePreviewSrc(STORED));
    const second = renderHook(() => usePreviewSrc(STORED));

    act(() => first.result.current.onError());

    expect(second.result.current.src).toBe(STORED);
  });

  it('ignores an error from the original itself', () => {
    const { result } = renderHook(() => usePreviewSrc(STORED));
    act(() => result.current.onError());

    act(() => result.current.onError());

    expect(result.current.src).toBe(STORED);
  });
});

describe('usePreviewSrc probing for a poster', () => {
  const created: {
    src: string;
    naturalWidth: number;
    onerror: (() => void) | null;
    onload: (() => void) | null;
  }[] = [];

  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        naturalWidth = 0;
        onerror: (() => void) | null = null;
        onload: (() => void) | null = null;
        constructor() {
          created.push(this);
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the preview off-screen and falls back when it is missing', () => {
    const { result } = renderHook(() => usePreviewSrc(STORED, { probe: true }));

    expect(result.current.src).toBe(PREVIEW);
    expect(created[0]?.src).toBe(PREVIEW);

    act(() => created[0]?.onerror?.());

    expect(result.current.src).toBe(STORED);
  });

  it('records how wide the preview it loaded is', () => {
    renderHook(() => usePreviewSrc(STORED, { probe: true }));
    const width = renderHook(() => usePreviewWidth(STORED));

    act(() => {
      const image = created[0]!;
      image.naturalWidth = 384;
      image.onload?.();
    });

    expect(width.result.current).toBe(384);
  });
});

// The canvas switches a node to its original once it covers more device
// pixels than its preview has; the preview's own width is read off the
// loaded image, so nothing on the page predicts how the container sized it.
describe('usePreviewWidth', () => {
  it('knows nothing before the preview has loaded', () => {
    const { result } = renderHook(() => usePreviewWidth(STORED));

    expect(result.current).toBeNull();
  });

  it('gives the natural width of the preview an element loaded', () => {
    const shown = renderHook(() => usePreviewSrc(STORED));
    const width = renderHook(() => usePreviewWidth(STORED));

    act(() => shown.result.current.onLoad({ currentTarget: { naturalWidth: 273 } }));

    expect(width.result.current).toBe(273);
  });

  it('records nothing when the element showed the original', () => {
    const shown = renderHook(() => usePreviewSrc(STORED, { enabled: false }));
    const width = renderHook(() => usePreviewWidth(STORED));

    act(() => shown.result.current.onLoad({ currentTarget: { naturalWidth: 4000 } }));

    expect(width.result.current).toBeNull();
  });

  it('knows nothing for an address with no preview', () => {
    const { result } = renderHook(() => usePreviewWidth('https://images.example.com/a.png'));

    expect(result.current).toBeNull();
  });
});

describe('usePreviewSrc when another image fails', () => {
  it('does not re-render a consumer showing a different image', () => {
    const other = `https://resource-dev.breatic.cc/image/2026-09-30/2_${UUID}.png`;
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return usePreviewSrc(other);
    });
    const failing = renderHook(() => usePreviewSrc(STORED));
    const before = renders;

    act(() => {
      failing.result.current.onError();
    });

    expect(failing.result.current.src).toBe(STORED);
    expect(renders).toBe(before);
  });
});
