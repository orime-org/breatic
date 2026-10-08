// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStore } from '@xyflow/react';
import * as React from 'react';

import { isModelTool, miniToolById, type RectParam } from '@breatic/shared/mini-tools';

import type { CropRect } from '@web/lib/crop-math';
import { presetRatio } from '@web/lib/crop-math';
import { useCanvasSession, useCanvasSessionStore } from '@web/spaces/canvas/canvas-context';
import { fromFraction, offsetWithin, toFraction, type BoxSize } from '@web/spaces/canvas/crop/crop-geometry';
import { NodeCropFrame } from '@web/spaces/canvas/crop/NodeCropFrame';
import { intrinsicSize, isCropSource, MEDIA_SELECTOR, originalSrc, type CropSourceEl } from '@web/spaces/canvas/focus/crop-source';
import { aspectRatioOf, type CropRect as SourceRect } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import type { FocusCrop, MiniToolDraft } from '@web/stores/canvas-session';

/** Where the shown media is in the node, and what it is. */
interface Geometry {
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
function readGeometry(wrapper: HTMLElement | null): Geometry | null {
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
function sameGeometry(a: Geometry | null, b: Geometry | null): boolean {
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
function useMediaGeometry(root: HTMLElement | null, active: boolean): Geometry | null {
  const [geometry, setGeometry] = React.useState<Geometry | null>(null);
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

/**
 * Count the writes to a marquee made by anyone but its crop box. The box
 * records each value it writes; a stored value that is not one of them came
 * from elsewhere (Esc, Cancel, a ratio item, the panel, a reset), and a new
 * count tells the box to drop the gesture it holds.
 * @param stored - The marquee as the store holds it now.
 * @returns The count, and the function the box writes through.
 */
function useWrittenElsewhere<T>(stored: T): { count: number; wrote: (value: T) => void } {
  const ours = React.useRef<T>(stored);
  const seen = React.useRef<T>(stored);
  const count = React.useRef(0);
  if (stored !== seen.current) {
    if (stored !== ours.current) count.current += 1;
    seen.current = stored;
  }
  const wrote = React.useCallback((value: T): void => {
    ours.current = value;
  }, []);
  return { count: count.current, wrote };
}

/**
 * The crop param of the open tool, when it has one.
 * @param draft - The open mini-tool draft.
 * @returns The rect param, or undefined.
 */
function rectParamOf(draft: MiniToolDraft | null): RectParam | undefined {
  if (draft === null) return undefined;
  const spec = miniToolById(draft.toolId);
  if (spec === undefined || isModelTool(spec)) return undefined;
  return spec.params.find((param): param is RectParam => param.kind === 'rect');
}

interface NodeCropLayerProps {
  /** The node this layer belongs to. */
  nodeId: string;
  /**
   * The node's outer positioned wrapper, outside the clipping card. An element
   * rather than a ref: a node shown again attaches its refs after this layer's
   * effects have run, and only a change of value re-runs them.
   */
  wrapper: HTMLElement | null;
}

/**
 * The crop box of one node (inner#888 §7.4.1): the focus crop when this node
 * is the focus target, the crop tool's box when a crop tool's panel is open
 * on it. It reads the media's place in the node and reports what it sees —
 * the focus target's box to the focus crop, the source's own pixel size to
 * the tool's draft — and is the only writer of both.
 * @param root0 - Component props.
 * @param root0.nodeId - The node.
 * @param root0.wrapper - The node's outer wrapper.
 * @returns The crop box, or null when this node is not being cropped.
 */
export function NodeCropLayer({ nodeId, wrapper }: NodeCropLayerProps): React.JSX.Element | null {
  const store = useCanvasSessionStore();
  const focus = useCanvasSession((s) => (s.focusCrop?.nodeId === nodeId ? s.focusCrop : null));
  const draft = useCanvasSession((s) =>
    s.panelKind === 'miniTool' && s.panelHostId === nodeId && s.pickSession === null ? s.miniTool : null,
  );
  const rectParam = rectParamOf(draft);
  const zoom = useStore((s) => s.transform[2]);
  const geometry = useMediaGeometry(wrapper, focus !== null || rectParam !== undefined);
  const focusWrites = useWrittenElsewhere(focus?.rect ?? null);
  const toolWrites = useWrittenElsewhere<unknown>(
    rectParam === undefined || draft === null ? null : (draft.params[rectParam.key] ?? null),
  );

  // The focus target's box, for the controls bar under the node and for Esc.
  const focusing = focus !== null;
  React.useEffect(() => {
    if (!focusing) return;
    const state = store.getState();
    state.setFocusFrame(
      nodeId,
      geometry === null ? null : { width: geometry.box.width, height: geometry.box.height, natural: geometry.natural },
    );
  }, [focusing, geometry, nodeId, store]);
  React.useEffect(
    () => () => {
      store.getState().setFocusFrame(nodeId, null);
    },
    [nodeId, store],
  );

  // The tool's source size, read off the element the export crops.
  const toolNatural = rectParam === undefined ? null : (geometry?.natural ?? null);
  React.useEffect(() => {
    if (toolNatural !== null) store.getState().setMiniToolSourceSize(toolNatural);
  }, [toolNatural?.width, toolNatural?.height, toolNatural, store]);

  const toBoxPoint = React.useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      if (geometry === null) return { x: 0, y: 0 };
      const shown = geometry.el.getBoundingClientRect();
      return {
        x: ((clientX - shown.left) * geometry.box.width) / shown.width,
        y: ((clientY - shown.top) * geometry.box.height) / shown.height,
      };
    },
    [geometry],
  );

  const onFocusChange = React.useCallback(
    (rect: CropRect | null): void => {
      const state = store.getState();
      const current = state.focusCrop;
      // A box going away after the target moved on must not write onto the next one.
      if (current?.nodeId !== nodeId || geometry === null) return;
      const frac = rect === null ? null : toFraction(rect, geometry.box);
      focusWrites.wrote(frac);
      state.setFocusMarquee(frac, frac === null ? null : current.preset);
    },
    [focusWrites, geometry, nodeId, store],
  );

  const rectKey = rectParam?.key;
  const onToolChange = React.useCallback(
    (rect: CropRect | null): void => {
      const state = store.getState();
      if (rectKey === undefined || geometry === null || toolNatural === null) return;
      if (state.panelHostId !== nodeId || state.panelKind !== 'miniTool') return;
      if (rect === null) {
        toolWrites.wrote(null);
        state.setMiniToolParam(rectKey, null);
        return;
      }
      const sx = toolNatural.width / geometry.box.width;
      const sy = toolNatural.height / geometry.box.height;
      const x = Math.round(rect.x * sx);
      const y = Math.round(rect.y * sy);
      const next: SourceRect = {
        x,
        y,
        w: Math.max(1, Math.min(toolNatural.width - x, Math.round(rect.width * sx))),
        h: Math.max(1, Math.min(toolNatural.height - y, Math.round(rect.height * sy))),
      };
      toolWrites.wrote(next);
      state.setMiniToolParam(rectKey, next);
    },
    [geometry, nodeId, rectKey, store, toolNatural, toolWrites],
  );

  if (geometry === null) return null;

  if (focus !== null) {
    return (
      <FocusFrame
        // A different picture under the same node is a fresh box.
        key={geometry.src ?? ''}
        focus={focus}
        geometry={geometry}
        zoom={zoom}
        toBoxPoint={toBoxPoint}
        onChange={onFocusChange}
        writtenElsewhere={focusWrites.count}
      />
    );
  }

  if (rectParam === undefined || draft === null || toolNatural === null) return null;
  const held = draft.params[rectParam.key] as SourceRect | null | undefined;
  const sx = geometry.box.width / toolNatural.width;
  const sy = geometry.box.height / toolNatural.height;
  const rect: CropRect =
    held === null || held === undefined
      ? { x: 0, y: 0, width: geometry.box.width, height: geometry.box.height }
      : { x: held.x * sx, y: held.y * sy, width: held.w * sx, height: held.h * sy };
  const aspect = rectParam.aspect === undefined ? undefined : draft.params[rectParam.aspect];
  return (
    <NodeCropFrame
      key={geometry.src ?? ''}
      testIdPrefix='mini-tool-crop'
      at={geometry.at}
      box={geometry.box}
      rect={rect}
      ratio={aspectRatioOf(aspect, toolNatural)}
      natural={toolNatural}
      zoom={zoom}
      toBoxPoint={toBoxPoint}
      onChange={onToolChange}
      writtenElsewhere={toolWrites.count}
    />
  );
}

interface FocusFrameProps {
  writtenElsewhere: number;
  focus: FocusCrop;
  geometry: Geometry;
  zoom: number;
  toBoxPoint: (clientX: number, clientY: number) => { x: number; y: number };
  onChange: (rect: CropRect | null) => void;
}

/**
 * The focus crop's box: the marquee held as fractions, drawn in box pixels.
 * @param root0 - Component props.
 * @param root0.focus - The focus crop.
 * @param root0.geometry - The media's place in the node.
 * @param root0.zoom - The canvas zoom.
 * @param root0.toBoxPoint - Maps a pointer into box pixels.
 * @param root0.onChange - Receives the marquee in box pixels.
 * @param root0.writtenElsewhere - Counts the writes made by others.
 * @returns The box.
 */
function FocusFrame({ focus, geometry, zoom, toBoxPoint, onChange, writtenElsewhere }: FocusFrameProps): React.JSX.Element {
  const rect = React.useMemo(
    () => (focus.rect === null ? null : fromFraction(focus.rect, geometry.box)),
    [focus.rect, geometry.box],
  );
  return (
    <NodeCropFrame
      testIdPrefix='focus-crop'
      at={geometry.at}
      box={geometry.box}
      rect={rect}
      ratio={presetRatio(focus.preset, geometry.natural)}
      natural={geometry.natural}
      zoom={zoom}
      toBoxPoint={toBoxPoint}
      onChange={onChange}
      writtenElsewhere={writtenElsewhere}
    />
  );
}
