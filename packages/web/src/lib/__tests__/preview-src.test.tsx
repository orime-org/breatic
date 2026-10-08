// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetPreviewFailures, usePreviewSrc } from '@web/lib/preview-src';

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
  const created: { src: string; onerror: (() => void) | null }[] = [];

  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        onerror: (() => void) | null = null;
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
});
