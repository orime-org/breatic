// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { offsetWithin, type BoxSize } from '@web/spaces/canvas/crop/crop-geometry';
import { intrinsicSize, isCropSource, MEDIA_SELECTOR, originalSrc, type CropSourceEl } from '@web/spaces/canvas/focus/crop-source';

/** Where the shown media is in the node, and what it is. */
export interface MediaGeometry {
  readonly el: CropSourceEl;
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
  const el = wrapper.querySelector(MEDIA_SELECTOR);
  if (!isCropSource(el)) return null;
  const at = offsetWithin(el, wrapper);
  const box = { width: el.offsetWidth, height: el.offsetHeight };
  if (at === null || box.width <= 0 || box.height <= 0) return null;
  const size = intrinsicSize(el);
  return {
    el,
    at,
    box,
    natural: size.width > 0 && size.height > 0 ? size : null,
    src: originalSrc(el),
  };
}

/**
 * Whether two readings describe the same media in the same place.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when nothing a reader sees has changed.
 */
function sameGeometry(a: MediaGeometry | null, b: MediaGeometry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.el === b.el &&
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
 * @returns The current reading, or null.
 */
export function useMediaGeometry(root: HTMLElement | null, active: boolean): MediaGeometry | null {
  const [geometry, setGeometry] = React.useState<MediaGeometry | null>(null);
  React.useLayoutEffect(() => {
    if (!active || root === null) {
      setGeometry(null);
      return;
    }
    let watched: CropSourceEl | null = null;
    const sizes = new ResizeObserver(() => refresh());
    /** Re-read the media and watch whichever element is there now. */
    const refresh = (): void => {
      const next = readGeometry(root);
      const el = root.querySelector(MEDIA_SELECTOR);
      const media = isCropSource(el) ? el : null;
      if (media !== watched) {
        if (watched !== null) {
          sizes.unobserve(watched);
          watched.removeEventListener('load', refresh);
          watched.removeEventListener('loadedmetadata', refresh);
        }
        watched = media;
        if (watched !== null) {
          sizes.observe(watched);
          watched.addEventListener('load', refresh);
          watched.addEventListener('loadedmetadata', refresh);
        }
      }
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    const dom = new MutationObserver(refresh);
    dom.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    refresh();
    return () => {
      dom.disconnect();
      sizes.disconnect();
      watched?.removeEventListener('load', refresh);
      watched?.removeEventListener('loadedmetadata', refresh);
    };
  }, [active, root]);
  return geometry;
}
