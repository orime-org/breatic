// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U03 (frames-split design §7.8 "几何读取" and the surface list row for the earlier video crop
 * tools, `NodeCropLayer.tsx` and `media-geometry.ts`): with a selected version P the node plays P's playback file, whose
 * short side is at most 1080, so the tool's source size is `P.display`, never the playing element's
 * `videoWidth`/`videoHeight`. A box drawn on the node then lands on the same source pixels whatever file plays: on a 4K
 * source playing a 1920×1080 file, the right half of the node is the right half of the 3840 source pixels, not its second
 * quarter.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useMediaGeometry } from '../media-geometry';
import { fromFraction, toFraction } from '../crop-geometry';

type Size = { width: number; height: number };
type Hook = (root: HTMLElement | null, active: boolean, display?: Size | null) => ReturnType<typeof useMediaGeometry>;
const useGeometry: Hook = useMediaGeometry;

/**
 * A node wrapper holding a playing video laid out 400×225 and decoded at the given size.
 * @param decoded - The playing file's pixel size.
 * @returns The wrapper.
 */
function nodeWith(decoded: Size): HTMLElement {
  const root = document.createElement('div');
  const video = document.createElement('video');
  video.setAttribute('data-testid', 'media-element');
  video.setAttribute('src', 'https://assets.example.test/playback.mp4');
  Object.defineProperties(video, {
    videoWidth: { value: decoded.width }, videoHeight: { value: decoded.height },
    offsetWidth: { value: 400 }, offsetHeight: { value: 225 }, offsetLeft: { value: 0 }, offsetTop: { value: 0 }, offsetParent: { value: root },
  });
  root.append(video);
  document.body.append(root);
  return root;
}

afterEach(() => { document.body.replaceChildren(); });

describe('U03 the crop tools read the source size from P.display (§7.8)', () => {
  it('U03: a 4K source playing a 1920×1080 file reports P.display 3840×2160 as its source size', () => {
    const root = nodeWith({ width: 1920, height: 1080 });
    const { result } = renderHook(() => useGeometry(root, true, { width: 3840, height: 2160 }));
    expect(result.current?.natural).toEqual({ width: 3840, height: 2160 });
  });

  it('U03: a box over the right half of the node lands on the right half of the source pixels', () => {
    const root = nodeWith({ width: 1920, height: 1080 });
    const { result } = renderHook(() => useGeometry(root, true, { width: 3840, height: 2160 }));
    const geometry = result.current!;
    const pixels = fromFraction(toFraction({ x: 200, y: 0, width: 200, height: 225 }, geometry.box), geometry.natural!);
    expect(pixels).toEqual({ x: 1920, y: 0, width: 1920, height: 2160 });
  });

  it('U03: a registered non-square-pixel source (SAR 4:3, stored 640×480) frames in its display geometry 853×480', () => {
    const root = nodeWith({ width: 854, height: 480 });
    const { result } = renderHook(() => useGeometry(root, true, { width: 853, height: 480 }));
    expect(result.current?.natural).toEqual({ width: 853, height: 480 });
  });
});
