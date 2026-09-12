// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which resolution a media node shows (#209).
 *
 * Two sources answer the same question: the numbers the ledger measured at
 * ingest, which arrive on the node's data, and what the browser reports once
 * the media has decoded. The ledger's win, and the DOM read stands in when
 * there is none.
 *
 * The node's data comes out of a Yjs map, which is typed by a cast rather than
 * checked, so what counts as "there is one" is measured here on values a map
 * can actually hold.
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/useNodeResolution';

describe('a node whose ledger row measured it', () => {
  it('shows those numbers, before anything has decoded', () => {
    const { result } = renderHook(() =>
      useNodeResolution('https://example.invalid/a.png', 1920, 1080),
    );

    expect(result.current.resolution).toEqual({ width: 1920, height: 1080 });
  });

  it('keeps them when the media reports something else', () => {
    const { result } = renderHook(() =>
      useNodeResolution('https://example.invalid/a.png', 1920, 1080),
    );

    act(() => {
      result.current.setResolution({ width: 640, height: 480 });
    });

    expect(result.current.resolution).toEqual({ width: 1920, height: 1080 });
  });
});

describe('a node with no measurement on its row', () => {
  it('shows nothing until the media reports its size', () => {
    const { result } = renderHook(() =>
      useNodeResolution('https://example.invalid/a.png'),
    );

    expect(result.current.resolution).toBeUndefined();

    act(() => {
      result.current.setResolution({ width: 640, height: 480 });
    });

    expect(result.current.resolution).toEqual({ width: 640, height: 480 });
  });

  // What a document written before the ingest measurement existed holds, and
  // what a client on an older build still writes. Anything but a number is no
  // measurement — reading it as one puts the word null where a size belongs.
  it('treats a null on the node the same as no measurement at all', () => {
    const { result } = renderHook(() =>
      useNodeResolution(
        'https://example.invalid/a.png',
        null as unknown as undefined,
        null as unknown as undefined,
      ),
    );

    expect(result.current.resolution).toBeUndefined();

    act(() => {
      result.current.setResolution({ width: 640, height: 480 });
    });

    expect(result.current.resolution).toEqual({ width: 640, height: 480 });
  });

  it('ignores half a pair, which describes no frame', () => {
    const { result } = renderHook(() =>
      useNodeResolution('https://example.invalid/a.png', 1920, undefined),
    );

    expect(result.current.resolution).toBeUndefined();
  });
});

describe('a node whose content is swapped', () => {
  it('drops what the previous media reported', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) => useNodeResolution(content),
      { initialProps: { content: 'https://example.invalid/a.png' } },
    );

    act(() => {
      result.current.setResolution({ width: 640, height: 480 });
    });
    expect(result.current.resolution).toEqual({ width: 640, height: 480 });

    rerender({ content: 'https://example.invalid/b.png' });

    expect(result.current.resolution).toBeUndefined();
  });
});
