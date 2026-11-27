// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { offsetWithin } from '@web/spaces/canvas/crop/crop-geometry';

/** The canonical presentation's actual CSS box relative to its node wrapper. */
export interface VideoDisplayGeometry {
  element: HTMLElement;
  at: { x: number; y: number };
  box: { width: number; height: number };
  src: string;
}

/** Each canonical display surface's native video: the surface is what shows, the video is the clock it shows. */
const displayVideos = new WeakMap<Element, HTMLVideoElement>();

/**
 * Marks a surface as the canonical display of a source and records the native video it shows. An alpha-packed surface
 * is a canvas drawn from a video kept out of the document, so the video is found through the surface.
 * @param surface - The element on screen: the native video itself, or the packed renderer's canvas.
 * @param video - The binding's native video element.
 * @param src - The canonical source URL.
 * @throws {never} Never.
 */
export function bindVideoDisplay(surface: HTMLElement, video: HTMLVideoElement, src: string): void {
  surface.setAttribute('data-canonical-video-display', src);
  displayVideos.set(surface, video);
}

/**
 * The native video a canonical display surface shows.
 * @param surface - An element carrying `data-canonical-video-display`.
 * @returns The video, or null when the surface is not bound.
 * @throws {never} Never.
 */
export function videoOfDisplay(surface: Element): HTMLVideoElement | null {
  return displayVideos.get(surface) ?? null;
}

/**
 * Reads display geometry without consulting a hidden packed decoder.
 * @param wrapper - The positioned canvas node wrapper.
 * @returns Its actual canonical display box, when measured.
 * @throws {never} Missing or unmeasured display boxes return null.
 */
export function readVideoDisplayGeometry(wrapper: HTMLElement | null): VideoDisplayGeometry | null {
  const element = wrapper?.querySelector('[data-canonical-video-display]');
  if (wrapper === null || !(element instanceof HTMLElement)) return null;
  const src = element.getAttribute('data-canonical-video-display');
  const at = offsetWithin(element, wrapper);
  const width = element.offsetWidth; const height = element.offsetHeight;
  return src && at && width > 0 && height > 0 ? { element, at, box: { width, height }, src } : null;
}

/**
 * Follows the actual canonical display while its node overlay is active.
 * @param wrapper - The positioned node wrapper.
 * @param active - Whether this tool currently needs display geometry.
 * @returns The current pure-media box, independent of fullscreen controls.
 * @throws {never} Missing display geometry remains null.
 */
export function useVideoDisplayGeometry(wrapper: HTMLElement | null, active: boolean): VideoDisplayGeometry | null {
  const [geometry, setGeometry] = React.useState<VideoDisplayGeometry | null>(null);
  React.useLayoutEffect(() => {
    if (!wrapper || !active) { setGeometry(null); return undefined; }
    let element: HTMLElement | null = null;
    const sizes = new ResizeObserver(() => refresh());
    /**
     * Re-reads the same layout coordinate system after an owned surface changes.
     * @throws {never} Never.
     */
    function refresh(): void {
      const next = readVideoDisplayGeometry(wrapper);
      const candidate = wrapper!.querySelector('[data-canonical-video-display]');
      const displayed = candidate instanceof HTMLElement ? candidate : null;
      if (element !== displayed) {
        if (element) sizes.unobserve(element);
        element = displayed;
        if (element) sizes.observe(element);
      }
      setGeometry((before) => before?.element === next?.element && before?.src === next?.src && before?.at.x === next?.at.x && before?.at.y === next?.at.y && before?.box.width === next?.box.width && before?.box.height === next?.box.height ? before : next);
    }
    const dom = new MutationObserver(refresh);
    dom.observe(wrapper, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-canonical-video-display'] });
    refresh();
    return () => { dom.disconnect(); sizes.disconnect(); };
  }, [wrapper, active]);
  return geometry;
}
