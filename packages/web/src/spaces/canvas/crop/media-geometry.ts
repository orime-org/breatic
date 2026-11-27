// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';

import { offsetWithin, type BoxSize } from '@web/spaces/canvas/crop/crop-geometry';
import { cropMediaOf, intrinsicSize, MEDIA_SELECTOR, originalSrc, type CropMedia, type CropSourceEl } from '@web/spaces/canvas/focus/crop-source';

/** Where the shown media is in the node, and what it is. */
export interface MediaGeometry {
  /** The element the size and clock come from. */
  readonly el: CropSourceEl;
  /** The element on screen, where the box is measured: `el` itself except for a transparent video's canvas. */
  readonly shown: HTMLElement;
  readonly at: { x: number; y: number };
  readonly box: BoxSize;
  readonly natural: BoxSize | null;
  readonly src: string | null;
}

/**
 * Read the media's place in the node. The media is looked up again each time:
 * a handling cycle or a remount replaces the element under the same node.
 * @param wrapper - The node's outer wrapper.
 * @returns The geometry, or null while there is no media with a box.
 */
function readGeometry(wrapper: HTMLElement | null): MediaGeometry | null {
  if (wrapper === null) return null;
  const media = cropMediaOf(wrapper.querySelector(MEDIA_SELECTOR));
  if (media === null) return null;
  const { shown, source } = media;
  const at = offsetWithin(shown, wrapper);
  const box = { width: shown.offsetWidth, height: shown.offsetHeight };
  if (at === null || box.width <= 0 || box.height <= 0) return null;
  const size = intrinsicSize(source);
  return {
    el: source,
    shown,
    at,
    box,
    natural: size.width > 0 && size.height > 0 ? size : null,
    src: originalSrc(shown),
  };
}

/**
 * Whether two readings describe the same media in the same place.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when nothing a user sees has changed.
 */
function sameGeometry(a: MediaGeometry | null, b: MediaGeometry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.el === b.el &&
    a.shown === b.shown &&
    a.src === b.src &&
    a.at.x === b.at.x &&
    a.at.y === b.at.y &&
    a.box.width === b.box.width &&
    a.box.height === b.box.height &&
    a.natural?.width === b.natural?.width &&
    a.natural?.height === b.natural?.height
  );
}

/**
 * Follow the media inside a node while `active`: its place, its size, its
 * own pixel size and its address, re-read when the node's DOM changes, when
 * the media resizes, or when it finishes loading.
 * @param root - The node's outer wrapper.
 * @param active - Whether anything on this node needs it.
 * @param display - The size the source is cut in: the selected version's display (P.display), or for a video with none
 *   its registered size; with one, never the playing element's `videoWidth`/`videoHeight` (frames-split §7.8 geometry reads).
 * @returns The current reading, or null.
 */
export function useMediaGeometry(root: HTMLElement | null, active: boolean, display?: { width: number; height: number } | null): MediaGeometry | null {
  const [geometry, setGeometry] = React.useState<MediaGeometry | null>(null);
  React.useLayoutEffect(() => {
    if (!active || root === null) {
      setGeometry(null);
      return;
    }
    let watched: CropMedia | null = null;
    const sizes = new ResizeObserver(() => refresh());
    /**
     * Stop watching the media watched so far.
     * @param media - The media.
     */
    const unwatch = (media: CropMedia): void => {
      sizes.unobserve(media.shown);
      media.source.removeEventListener('load', refresh);
      media.source.removeEventListener('loadedmetadata', refresh);
    };
    /** Re-read the media and watch whichever element is there now: its size on screen, its source's loads. */
    const refresh = (): void => {
      const next = readGeometry(root);
      const media = cropMediaOf(root.querySelector(MEDIA_SELECTOR));
      if (media?.shown !== watched?.shown || media?.source !== watched?.source) {
        if (watched !== null) unwatch(watched);
        watched = media;
        if (watched !== null) {
          sizes.observe(watched.shown);
          watched.source.addEventListener('load', refresh);
          watched.source.addEventListener('loadedmetadata', refresh);
        }
      }
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    const dom = new MutationObserver(refresh);
    dom.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-canonical-video-display'] });
    refresh();
    return () => {
      dom.disconnect();
      sizes.disconnect();
      if (watched !== null) unwatch(watched);
    };
  }, [active, root]);
  const displayWidth = display?.width;
  const displayHeight = display?.height;
  return React.useMemo(() => geometry === null || displayWidth === undefined || displayHeight === undefined ? geometry
    : { ...geometry, natural: { width: displayWidth, height: displayHeight } }, [geometry, displayWidth, displayHeight]);
}
