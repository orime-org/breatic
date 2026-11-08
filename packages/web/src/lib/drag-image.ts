// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The image that follows the pointer while content is dragged out of an
 * editor: the prompt box, the Agent input and the document body all put
 * theirs on the page here, so each is drawn the same way (inner#1515).
 *
 * It is drawn at full strength, as every editor that draws its own drag image
 * does (BlockNote, Tiptap's drag handle, Lexical, Plate, AFFiNE, Outline,
 * Milkdown, Novel). The root is opaque and fixed at the viewport's top left
 * (`index.css`): Firefox and WebKit draw the root's own opacity into the
 * image, and Safari cancels a drag whose image is wholly off screen. The
 * browser takes the image while `dragstart` is dispatched, so the root leaves
 * the page in the next animation frame, before that frame is painted, or at
 * the drag's next event if that comes first (inner#1350 design §4).
 *
 * A side longer than 512px is scaled down until the longest is 512px. Chrome
 * draws the image in the root's own space, leaving out the root's transform
 * (`data_transfer.cc`), so the root takes the scaled size and the scale sits
 * on the layer inside it.
 */

/** The class `index.css` places and styles every drag image by. */
export const DRAG_IMAGE_CLASS = 'drag-image';

/** The longest a drag image's side may be, in px (user 2026-10-10). */
export const DRAG_IMAGE_LONGEST_SIDE = 512;

/** A natural size, in px. */
export interface DragImageSize {
  readonly width: number;
  readonly height: number;
}

/** A drag image on the page. */
export interface MountedDragImage {
  /** The element to hand to `setDragImage`. */
  readonly root: HTMLElement;
  /** What the content is drawn at, 1 when it is not scaled down. */
  readonly scale: number;
}

/**
 * The scale that brings a longest side over {@link DRAG_IMAGE_LONGEST_SIDE}
 * down to it. It never enlarges: the browser clamps a drag image the same way,
 * shrinking only what is over its limit (Chromium `drag_image.cc`
 * `ClampedImageScale`).
 * @param width - The natural width.
 * @param height - The natural height.
 * @returns The scale, 1 at most.
 */
export function dragImageScale(width: number, height: number): number {
  const longest = Math.max(width, height);
  return longest > DRAG_IMAGE_LONGEST_SIDE ? DRAG_IMAGE_LONGEST_SIDE / longest : 1;
}

/**
 * The layer's laid-out size.
 * @param layer - The layer the content sits in.
 * @returns Its size.
 */
function measureBox(layer: HTMLElement): DragImageSize {
  const box = layer.getBoundingClientRect();
  return { width: box.width, height: box.height };
}

/** A drag's events, each dispatched once the browser has taken the image. */
const DRAG_EVENTS = ['drag', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend'] as const;

/**
 * Takes a drag image off the page once the browser has it: in the next
 * animation frame, before it is painted, or at the drag's next event if that
 * comes first. The window sees each first, in the capture phase.
 * @param root - The image's root.
 */
function leaveOnceTaken(root: HTMLElement): void {
  const frame = root.ownerDocument.defaultView ?? window;
  /** Takes the image off the page, and what would take it off again. */
  const leave = (): void => {
    frame.cancelAnimationFrame(next);
    DRAG_EVENTS.forEach((type) => frame.removeEventListener(type, leave, true));
    root.remove();
  };
  const next = frame.requestAnimationFrame(leave);
  DRAG_EVENTS.forEach((type) => frame.addEventListener(type, leave, true));
}

/**
 * Puts content on the page as a drag image, scaled, for the `dragstart` being
 * dispatched to hand to `setDragImage`. It takes itself off the page once the
 * browser has the image.
 * @param page - The document the drag is in.
 * @param content - What the image shows, laid out as it should be drawn.
 * @param measure - Reads the content's natural size once laid out.
 * @returns The root and the scale the content is drawn at.
 */
export function mountDragImage(
  page: Document,
  content: Node,
  measure: (layer: HTMLElement) => DragImageSize = measureBox,
): MountedDragImage {
  const root = page.createElement('div');
  root.className = DRAG_IMAGE_CLASS;
  root.style.overflow = 'hidden';
  const layer = page.createElement('div');
  layer.style.display = 'inline-block';
  // On the root's line an inline block sits on the baseline, below the line's
  // own ascent, and the root, cut to the scaled size, would clip its foot.
  layer.style.verticalAlign = 'top';
  layer.style.padding = '0';
  layer.style.transformOrigin = '0px 0px';
  layer.append(content);
  root.append(layer);
  page.body.append(root);
  const size = measure(layer);
  const scale = dragImageScale(size.width, size.height);
  root.style.width = `${size.width * scale}px`;
  root.style.height = `${size.height * scale}px`;
  layer.style.transform = `scale(${scale})`;
  leaveOnceTaken(root);
  return { root, scale };
}
