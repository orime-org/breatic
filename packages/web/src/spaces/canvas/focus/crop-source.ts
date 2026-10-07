// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the two crop overlays share: how a node's croppable element is found
 * and measured, and where the eight handles sit. The focus crop and the
 * mini-tool crop both draw over that element (inner#888 §7.4).
 */

import type { CropHandle } from '@web/lib/crop-math';

/** A node's croppable media, one selector per element kind. */
const MEDIA_SELECTORS = ['[data-testid=image-node-img]', '[data-testid=media-element]'] as const;

/** A node's croppable media, inside the node. */
export const MEDIA_SELECTOR = MEDIA_SELECTORS.join(', ');

/**
 * The croppable element inside ONE target node. Image nodes render an `<img>`;
 * video nodes render the shared media player's element, whose testid audio
 * nodes share — which is why the match is narrowed by TAG below rather than
 * trusted from the selector.
 *
 * A function rather than a constant because a comma in CSS separates whole
 * selectors: `#node img, [testid=x]` means "an img inside #node" OR "any
 * [testid=x] on the page". The node scope has to be repeated in each branch,
 * and the version that forgot to found the FIRST video on the canvas whenever
 * the crop target moved to a second one.
 * @param nodeId - The target node's ReactFlow id.
 * @returns A selector matching only that node's croppable element.
 */
export function cropSourceSelector(nodeId: string): string {
  const scope = `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`;
  return MEDIA_SELECTORS.map((one) => `${scope} ${one}`).join(', ');
}

/** Anything the nine-arg `drawImage` accepts as a source, in our nodes. */
export type CropSourceEl = HTMLImageElement | HTMLVideoElement;

/**
 * Whether a matched element is one we can crop.
 *
 * An audio node's `<audio>` carries the same testid as a video's `<video>`,
 * so the tag is the judge: `drawImage` has nothing to read off a sound.
 * @param el - The element the selector matched, if any.
 * @returns Whether it is croppable.
 */
export function isCropSource(el: Element | null): el is CropSourceEl {
  return el instanceof HTMLImageElement || el instanceof HTMLVideoElement;
}

/**
 * The source's own pixel size — the space crop rects are expressed in.
 *
 * Zero means "not decodable yet": a bitmap still loading, a broken URL, or a
 * video whose metadata has not arrived. Both element kinds report it, under
 * different names.
 * @param el - The crop source.
 * @returns Its intrinsic size, possibly `0 × 0`.
 */
export function intrinsicSize(el: CropSourceEl): { width: number; height: number } {
  return el instanceof HTMLImageElement
    ? { width: el.naturalWidth, height: el.naturalHeight }
    : { width: el.videoWidth, height: el.videoHeight };
}

/** The eight resize handles with their anchor classes (compass layout). */
export const CROP_HANDLES: ReadonlyArray<{ id: CropHandle; className: string }> = [
  { id: 'nw', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize' },
  { id: 'n', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' },
  { id: 'ne', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize' },
  { id: 'e', className: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
  { id: 'se', className: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize' },
  { id: 's', className: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize' },
  { id: 'sw', className: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize' },
  { id: 'w', className: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
];

