// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U03 (frames-split design §7.8 surface list row "节点分辨率角标" and "几何读取"): with a
 * selected version P the resolution badge shows `P.display`, the source's resolution, not the size the playing element
 * reports (the playback file's short side is at most 1080) and not the registered width and height, which take no part in
 * geometry; an uploaded non-square-pixel video (SAR 4:3) shows its display geometry.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useNodeResolution } from '@web/spaces/canvas/nodes/_shared/use-node-resolution';

type Size = { width: number; height: number };
type Hook = (content: string | undefined, width?: number, height?: number, display?: Size | null) => ReturnType<typeof useNodeResolution>;
const useResolution: Hook = useNodeResolution;
const url = 'https://assets.example.test/source.mov';

describe('U03 the resolution badge reads P.display (§7.8)', () => {
  it('U03: a 4K source playing a 1920×1080 file shows 3840×2160', () => {
    const { result } = renderHook(() => useResolution(url, 1920, 1080, { width: 3840, height: 2160 }));
    act(() => result.current.setResolution({ width: 1920, height: 1080 }));
    expect(result.current.resolution).toEqual({ width: 3840, height: 2160 });
  });

  it('U03: a registered SAR 4:3 video stored 640×480 shows its display geometry 853×480', () => {
    const { result } = renderHook(() => useResolution(url, 640, 480, { width: 853, height: 480 }));
    expect(result.current.resolution).toEqual({ width: 853, height: 480 });
  });

  it('U03: without a selected P the registered size stays the badge', () => {
    const { result } = renderHook(() => useResolution(url, 640, 480, null));
    expect(result.current.resolution).toEqual({ width: 640, height: 480 });
  });
});
