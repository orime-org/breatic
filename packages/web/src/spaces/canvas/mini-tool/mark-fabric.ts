// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Markup objects as Fabric draws them, and read back after the reader moves or
 * resizes one (inner#1303 §6.2). One conversion serves the node's canvas and
 * the export, so the two draw alike; sizes are shares of the picture's
 * shorter side, so they come out the same at the node's size and the source's.
 *
 * Loaded only with the markup canvas: Fabric is not part of the first page load.
 */

import { Ellipse, FabricImage, IText, Path, Point, Rect, util, type FabricObject } from 'fabric';

import type { MarkObject } from '@web/stores/mark-draft';

/** A picture's size in the pixels it is drawn at. */
export interface DrawBox {
  width: number;
  height: number;
}

/** What each Fabric object carries to tie it to its draft object. */
interface MarkTags {
  markId: string;
  markKind: MarkObject['kind'];
  /** A line, arrow or pen's points as drawn, in the path's own coordinates. */
  markPoints?: readonly [number, number][];
  markColor: string;
  markSize: number;
}

/** A Fabric object with its markup tags. */
export type MarkFabricObject = FabricObject & MarkTags;

/** A size's stroke width, as a share of the shorter side. */
const STROKE_PER_SIZE = 1 / 400;

/** A size's font size, as a share of the shorter side. */
const FONT_PER_SIZE = 1 / 100;

/**
 * A size's stroke width in the pixels of `box`.
 * @param size - The size, from the brush size slider.
 * @param box - The picture's drawn size.
 * @returns The width.
 */
export function markStrokePx(size: number, box: DrawBox): number {
  return Math.min(box.width, box.height) * size * STROKE_PER_SIZE;
}

/**
 * A size's font size in the pixels of `box`.
 * @param size - The size.
 * @param box - The picture's drawn size.
 * @returns The font size.
 */
export function markFontPx(size: number, box: DrawBox): number {
  return Math.min(box.width, box.height) * size * FONT_PER_SIZE;
}

/** What every markup object shares: a fixed stroke, no rotation, no skew, no flip. */
const LOCKS = {
  strokeUniform: true,
  lockSkewingX: true,
  lockSkewingY: true,
  lockScalingFlip: true,
  lockRotation: true,
  objectCaching: false,
} as const;

/**
 * An arrow's path: the shaft, then the two strokes of the head at its end.
 * @param a - The tail.
 * @param b - The tip.
 * @param stroke - The stroke width.
 * @returns The path data.
 */
function arrowPath(a: [number, number], b: [number, number], stroke: number): string {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const head = stroke * 4;
  /**
   * One stroke of the head, turned off the shaft.
   * @param turn - The turn, in radians.
   * @returns Its far end.
   */
  const side = (turn: number): [number, number] => [
    b[0] - head * Math.cos(angle + turn),
    b[1] - head * Math.sin(angle + turn),
  ];
  const [l, r] = [side(Math.PI / 7), side(-Math.PI / 7)];
  return `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]} M ${l[0]} ${l[1]} L ${b[0]} ${b[1]} L ${r[0]} ${r[1]}`;
}

/**
 * Tag a Fabric object and turn off what the draft cannot hold.
 * @param shape - The object.
 * @param tags - Its tags.
 * @returns The tagged object.
 */
function tagged<T extends FabricObject>(shape: T, tags: MarkTags): T & MarkTags {
  shape.set(LOCKS);
  shape.setControlVisible('mtr', false);
  // A text keeps its four corners only: its scale becomes its font size, which
  // has one value for both directions (inner#1303 §6.2).
  if (tags.markKind === 'text') shape.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
  return Object.assign(shape, tags);
}

/**
 * The picture under the objects in the export, laid from the top-left corner
 * the objects are measured from (Fabric's own default origin is the centre).
 * @param el - The loaded picture.
 * @returns The picture as a Fabric object.
 */
export function markBackground(el: HTMLImageElement | HTMLVideoElement): FabricImage {
  return new FabricImage(el, { left: 0, top: 0, originX: 'left', originY: 'top' });
}

/**
 * A markup text. Fabric drags a selection inside a text onto another text by
 * default, which the draft has no move for; and it puts its hidden text input
 * on the page body at the caret's place in the canvas's unzoomed pixels plus
 * the canvas's offset on screen, which is off the caret on a zoomed page (the
 * input method's candidates show away from it) and, past the window's edge,
 * scrolls the page when the input takes focus. Here the input sits in the
 * canvas's own box, which moves with the node, at the caret in the scene's
 * pixels, which are the box's.
 */
class MarkText extends IText {
  /** The picture's drawn size, which the scene is in. */
  private readonly box: DrawBox;

  /**
   * A text.
   * @param box - The picture's drawn size.
   * @param text - Its words.
   * @param options - Fabric's options.
   */
  constructor(box: DrawBox, text: string, options: ConstructorParameters<typeof IText>[1]) {
    super(text, options);
    this.box = box;
    // A press over the selected words is a press, so a drag selects a range:
    // the override Fabric names for "disable dragging and default to
    // mousedown logic" (`DraggableTextDelegate.ts` `start`). Without it no
    // drag begins, so `shouldStartDragging` and `onDragStart` answer false too.
    this.draggableTextDelegate.start = (): boolean => false;
  }

  /**
   * Never take dropped words.
   * @returns False.
   */
  override canDrop(): boolean {
    return false;
  }

  /** Make the hidden text input in the canvas's own box. */
  override initHiddenTextarea(): void {
    this.hiddenTextareaContainer = this.canvas?.wrapperEl ?? null;
    super.initHiddenTextarea();
  }

  /**
   * Where the hidden text input goes: at the caret, in the canvas's own pixels.
   * @returns Its place and the caret's height.
   */
  override _calcTextareaPosition(): { left: string; top: string; fontSize: string; charHeight: number } {
    const at = this.inCompositionMode ? this.compositionStart : this.selectionStart;
    const bounds = this._getCursorBoundaries(at);
    const { lineIndex, charIndex } = this.get2DCursorLocation(at);
    const charHeight = this.getValueOfPropertyAt(lineIndex, charIndex, 'fontSize') * this.lineHeight;
    const caret = new Point(bounds.left + bounds.leftOffset, bounds.top + bounds.topOffset + charHeight).transform(
      this.calcTransformMatrix(),
    );
    const x = Math.min(Math.max(caret.x, 0), Math.max(0, this.box.width - charHeight));
    const y = Math.min(Math.max(caret.y, 0), Math.max(0, this.box.height - charHeight));
    return { left: `${x}px`, top: `${y}px`, fontSize: `${charHeight}px`, charHeight };
  }
}

/**
 * Draw one markup object as a Fabric object at `box`'s pixels.
 * @param object - The object.
 * @param box - The picture's drawn size.
 * @returns The Fabric object.
 */
export function toFabric(object: MarkObject, box: DrawBox): MarkFabricObject {
  const stroke = markStrokePx(object.size, box);
  const base = { markId: object.id, markKind: object.kind, markColor: object.color, markSize: object.size };
  /**
   * A point in shares, in the box's pixels.
   * @param x - Across.
   * @param y - Down.
   * @returns The point.
   */
  const px = (x: number, y: number): [number, number] => [x * box.width, y * box.height];
  switch (object.kind) {
    case 'rect':
    case 'ellipse': {
      const common = {
        left: object.x * box.width,
        top: object.y * box.height,
        fill: 'transparent',
        stroke: object.color,
        strokeWidth: stroke,
        originX: 'left' as const,
        originY: 'top' as const,
      };
      return tagged(
        object.kind === 'rect'
          ? new Rect({ ...common, width: object.w * box.width, height: object.h * box.height })
          : new Ellipse({ ...common, rx: (object.w * box.width) / 2, ry: (object.h * box.height) / 2 }),
        base,
      );
    }
    case 'line':
    case 'arrow': {
      const a = px(object.x1, object.y1);
      const b = px(object.x2, object.y2);
      const data = object.kind === 'arrow' ? arrowPath(a, b, stroke) : `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`;
      const path = new Path(data, { fill: '', stroke: object.color, strokeWidth: stroke, strokeLineCap: 'round', strokeLineJoin: 'round' });
      return tagged(path, { ...base, markPoints: [a, b] });
    }
    case 'pen': {
      const points = object.points.map(([x, y]) => px(x, y));
      // Fabric's pencil smoothing, so the committed stroke is the one drawn.
      const samples = points.map(([x, y]) => new Point(x, y));
      const data = samples.length === 0 ? '' : util.getSmoothPathFromPoints(samples.length === 1 ? [samples[0]!, samples[0]!] : samples, stroke / 1000);
      const path = new Path(data, { fill: '', stroke: object.color, strokeWidth: stroke, strokeLineCap: 'round', strokeLineJoin: 'round' });
      return tagged(path, { ...base, markPoints: points });
    }
    case 'text': {
      const text = new MarkText(box, object.text, {
        left: object.x * box.width,
        top: object.y * box.height,
        fill: object.color,
        fontSize: markFontPx(object.size, box),
        originX: 'left',
        originY: 'top',
      });
      return tagged(text, base);
    }
  }
}

/**
 * Where a point of a path's own coordinates sits on the canvas now.
 * @param shape - The path.
 * @param point - The point as drawn.
 * @returns It on the canvas.
 */
function placed(shape: Path, point: readonly [number, number]): [number, number] {
  const moved = util.transformPoint(
    new Point(point[0] - shape.pathOffset.x, point[1] - shape.pathOffset.y),
    shape.calcTransformMatrix(),
  );
  return [moved.x, moved.y];
}

/**
 * Read a markup object back from its Fabric object, with any move or stretch
 * folded into its coordinates and a text's scale into its size.
 * @param shape - The Fabric object.
 * @param box - The picture's drawn size.
 * @returns The object.
 * @throws {Error} When the Fabric object carries no markup tags.
 */
export function fromFabric(shape: FabricObject, box: DrawBox): MarkObject {
  const tags = shape as Partial<MarkTags>;
  if (tags.markId === undefined || tags.markKind === undefined) throw new Error('not a markup object');
  const { markId: id, markColor: color = '', markSize: size = 1 } = tags;
  /**
   * A point in the box's pixels, in shares.
   * @param point - The point.
   * @returns It in shares.
   */
  const share = (point: readonly [number, number]): [number, number] => [point[0] / box.width, point[1] / box.height];
  switch (tags.markKind) {
    case 'rect':
    case 'ellipse':
      return {
        id,
        kind: tags.markKind,
        color,
        size,
        x: (shape.left ?? 0) / box.width,
        y: (shape.top ?? 0) / box.height,
        w: ((shape.width ?? 0) * (shape.scaleX ?? 1)) / box.width,
        h: ((shape.height ?? 0) * (shape.scaleY ?? 1)) / box.height,
      };
    case 'line':
    case 'arrow': {
      const [a, b] = (tags.markPoints ?? []).map((point) => share(placed(shape as Path, point)));
      return { id, kind: tags.markKind, color, size, x1: a?.[0] ?? 0, y1: a?.[1] ?? 0, x2: b?.[0] ?? 0, y2: b?.[1] ?? 0 };
    }
    case 'pen':
      return {
        id,
        kind: 'pen',
        color,
        size,
        points: (tags.markPoints ?? []).map((point) => share(placed(shape as Path, point))),
      };
    case 'text':
      return {
        id,
        kind: 'text',
        color,
        size: size * (shape.scaleX ?? 1),
        x: (shape.left ?? 0) / box.width,
        y: (shape.top ?? 0) / box.height,
        text: (shape as IText).text,
      };
  }
}
