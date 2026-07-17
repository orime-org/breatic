// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useStore } from '@xyflow/react';
import { toast } from 'sonner';

import { useTranslation } from '@web/i18n/use-translation';
import type { CapturedResize } from '@web/spaces/canvas/focus/crop-math';
import {
  CROP_RATIOS,
  MIN_CROP_PX,
  MIN_NATURAL_CROP_PX,
  captureResize,
  drawRect,
  isCropValid,
  isNaturalCropValid,
  resizeFromCapture,
  moveRect,
  applyRatioPreset,
  toNaturalCrop,
  type CropHandle,
  type CropRect,
} from '@web/spaces/canvas/focus/crop-math';

/** The eight resize handles with their anchor classes (compass layout). */
const HANDLES: ReadonlyArray<{ id: CropHandle; className: string }> = [
  { id: 'nw', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize' },
  { id: 'n', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' },
  { id: 'ne', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize' },
  { id: 'e', className: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
  { id: 'se', className: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize' },
  { id: 's', className: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize' },
  { id: 'sw', className: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize' },
  { id: 'w', className: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
];

/** What one confirmed marquee hands back to the canvas. */
export interface FocusCropConfirm {
  /** The crop in natural (source-resolution) pixels. */
  crop: CropRect;
  /** The source image's natural size (for reference / debugging). */
  natural: { width: number; height: number };
  /**
   * The src the marquee was drawn + validated against (round-3): the export
   * MUST crop exactly this URL — the graph store can lead the DOM by a
   * commit, and exporting the store's newer content at this marquee's
   * coordinates would crop the wrong image.
   */
  sourceSrc: string;
}

interface FocusCropOverlayProps {
  /** The image node being cropped (its `data-id` in the ReactFlow DOM). */
  nodeId: string;
  /**
   * The target node's flow position — only used as a re-measure signal
   * (drag moves the node under the overlay).
   */
  nodePosition: { x: number; y: number };
  /**
   * Confirm the current marquee (upload runs in the canvas layer). Returns
   * whether the confirm was ACCEPTED — a gate rejection (pool full, source
   * gone) returns false and the marquee is kept, so the user's careful
   * selection survives a fixable rejection (round-3).
   */
  onConfirm: (result: FocusCropConfirm) => boolean;
  /**
   * Return to the PICK state (clear the crop target, keep the session —
   * the banner stays and another image can be picked). Cancel and the
   * no-marquee Esc both land here (user 2026-07-17, decision A: leaving
   * one image's crop must not tear down the whole continuous session).
   * The overlay can NEVER hard-exit the session — that lives with the
   * banner Exit button and the canvas-level pick Esc handler.
   */
  onBackToPick: () => void;
}

/** An in-progress pointer interaction on the marquee layer. */
type Interaction = { pointerId: number } & (
  | { type: 'draw'; anchor: { x: number; y: number } }
  | { type: 'move'; last: { x: number; y: number } }
  | { type: 'resize'; capture: CapturedResize }
);

/**
 * Hands keyboard focus to the pick banner when the crop overlay is about to
 * unmount (adversarial 2026-07-17): the overlay disappears with focus inside
 * it, and without a hand-off document.activeElement falls to `<body>` — the
 * next Tab restarts from the top of the page. The banner is the surviving
 * surface of the pick state. Only focus that would otherwise be ORPHANED is
 * rescued (inside the overlay, or already on `<body>`) — never stolen from a
 * live surface outside it, like the prompt editor (adversarial round-2).
 * Exported for the canvas layer's third unmount path (crop target deleted by
 * a collaborator mid-crop).
 * @param overlayRoot - The overlay's root element (containment check), or
 * null when it cannot be resolved — then only `<body>` focus is rescued.
 */
export function handOffFocusToPickBanner(overlayRoot: Element | null): void {
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    !(overlayRoot?.contains(active) ?? false)
  ) {
    return;
  }
  document
    .querySelector<HTMLElement>('[data-testid="reference-pick-banner"]')
    ?.focus();
}

/**
 * The focus crop overlay (#1782): an absolutely-positioned marquee editor
 * aligned to the target node's rendered `<img>`. It lives OUTSIDE the
 * ReactFlow transform (a sibling of the pick banner inside the canvas
 * wrapper), so its controls keep a constant screen size at any zoom and
 * its pointer gestures never fight ReactFlow's — the capture layer eats
 * them before the canvas sees anything. The box is re-measured whenever
 * the viewport transform, the node position, or the window changes. All
 * geometry funnels through the pure crop-math module in the img's screen
 * pixel space; confirm maps to natural pixels via {@link toNaturalCrop}.
 * @param root0 - Component props.
 * @param root0.nodeId - The image node being cropped.
 * @param root0.nodePosition - The node's flow position (re-measure signal).
 * @param root0.onConfirm - Receives the confirmed natural-pixel crop.
 * @param root0.onBackToPick - Returns to the pick state (Cancel / bare Esc).
 * @returns The overlay, or null until the target img is measurable.
 */
export function FocusCropOverlay({
  nodeId,
  nodePosition,
  onConfirm,
  onBackToPick,
}: FocusCropOverlayProps): React.JSX.Element | null {
  const t = useTranslation();
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Viewport transform — any pan / zoom re-measures the image box.
  const transform = useStore((s) => s.transform);
  const [box, setBox] = React.useState<CropRect | null>(null);
  const [naturalSize, setNaturalSize] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const [rect, setRect] = React.useState<CropRect | null>(null);
  const [ratio, setRatio] = React.useState<number | null>(null);
  const interactionRef = React.useRef<Interaction | null>(null);
  // Force a state tick on interaction end so the controls bar re-evaluates.
  const [, setTick] = React.useState(0);
  // Mirror of `rect` for listeners that must read it without re-binding.
  const rectRef = React.useRef<CropRect | null>(null);
  rectRef.current = rect;
  // Mirror of `box` STATE (null while the img is culled) for the Esc gate:
  // stage-one must not silently eat an off-screen marquee (round-9).
  const boxStateRef = React.useRef<CropRect | null>(null);
  boxStateRef.current = box;
  // Mirror of the natural size for the pointer-up gauge (round-9): the
  // discard must use the SAME zoom-independent validity as Confirm.
  const naturalSizeRef = React.useRef<{ width: number; height: number } | null>(null);
  naturalSizeRef.current = naturalSize;
  // The img src the current marquee was drawn against — a content swap
  // (collaborator regenerate) invalidates the marquee entirely.
  const measuredSrcRef = React.useRef<string | null>(null);
  // Last measured box, read OUTSIDE state updaters (StrictMode-safe: no
  // side effects inside a setState updater).
  const prevBoxRef = React.useRef<CropRect | null>(null);
  // The img ELEMENT the marquee belongs to: a handling cycle unmounts and
  // remounts the img, killing element-bound observers and orphaning the
  // src baseline — measure() rebinds + re-baselines on identity change
  // (round-3, HIGH). The ResizeObserver is measure-managed for the same
  // reason (an effect-bound one would stay on the dead element).
  const lastImgElRef = React.useRef<HTMLImageElement | null>(null);
  const resizeObsRef = React.useRef<ResizeObserver | null>(null);

  const measure = React.useCallback((): void => {
    const root = rootRef.current;
    const img = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"] [data-testid=image-node-img]`,
    );
    if (!root || !(img instanceof HTMLImageElement)) {
      // The target's <img> is ABSENT. Node deletion unmounts the whole
      // overlay upstream (round-8), so reaching here is viewport CULLING
      // (onlyRenderVisibleElements) or a handling skeleton: keep the
      // marquee and the src baseline — a pan-away-and-back must not eat a
      // careful selection. Only the live gesture and the element-bound
      // observer die (their element did); the REMOUNT path below compares
      // the returning img's src against the kept baseline and discards
      // the marquee only when the content actually changed (round-5). A
      // gesture killed MID-FLIGHT never ran the pointer-up gauge — apply
      // it here so a sub-minimum sliver cannot survive into the return
      // (round-10, the degenerate-rect invariant).
      if (interactionRef.current && rectRef.current) {
        const nat = naturalSizeRef.current;
        const b = prevBoxRef.current;
        const valid =
          nat && b
            ? isNaturalCropValid(rectRef.current, b, nat)
            : isCropValid(rectRef.current);
        if (!valid) setRect(null);
      }
      interactionRef.current = null;
      lastImgElRef.current = null;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      setBox(null);
      return;
    }
    if (lastImgElRef.current !== img) {
      if (
        lastImgElRef.current !== null &&
        img.getAttribute('src') !== measuredSrcRef.current
      ) {
        // The img REMOUNTED with DIFFERENT content (handling cycle /
        // regenerate): the marquee and baselines belong to the dead
        // element — start fresh (round-3). The in-flight gesture dies with
        // it (round-4). A same-src remount (viewport culling return,
        // round-8) keeps the marquee — only the observer rebinds below.
        interactionRef.current = null;
        setRect(null);
        measuredSrcRef.current = null;
        prevBoxRef.current = null;
      }
      lastImgElRef.current = img;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObsRef.current?.disconnect();
        resizeObsRef.current = new ResizeObserver(measure);
        resizeObsRef.current.observe(img);
      }
    }
    const rootRect = root.getBoundingClientRect();
    const imgRect = img.getBoundingClientRect();
    const next = {
      x: imgRect.left - rootRect.left,
      y: imgRect.top - rootRect.top,
      width: imgRect.width,
      height: imgRect.height,
    };
    if (next.width <= 0 || next.height <= 0) {
      // The img is PRESENT but not laid out yet — a lazy-load remount
      // (#1772 culled-then-return) measures a zero box before decode.
      // A degenerate box cannot anchor the interactive layers, and
      // rescaling against it collapses the marquee to zero and then to
      // NaN on the post-decode measure (round-12). Keep the marquee and
      // every baseline untouched (this is also the ONLY write path into
      // `prevBoxRef`, so the rescale divisor stays positive by
      // construction); the ResizeObserver bound above re-measures the
      // moment real dimensions arrive.
      setBox(null);
      return;
    }
    const src = img.getAttribute('src');
    const prev = prevBoxRef.current;
    if (measuredSrcRef.current !== null && measuredSrcRef.current !== src) {
      // Content swap under the marquee (adversarial 2026-07-16): the old
      // display rect selects an arbitrary region of the NEW image —
      // discard it rather than crop the wrong thing. Abort the in-flight
      // gesture too (round-4: same resurrection mode as the Esc fix).
      interactionRef.current = null;
      setRect(null);
    } else if (
      prev &&
      rectRef.current &&
      (prev.width !== next.width || prev.height !== next.height)
    ) {
      // Zoom / node resize mid-marquee: keep the marquee glued to the SAME
      // image region by rescaling it with the box (adversarial 2026-07-16:
      // a stale display-px rect silently crops elsewhere).
      const sx = next.width / prev.width;
      const sy = next.height / prev.height;
      const r = rectRef.current;
      setRect({
        x: r.x * sx,
        y: r.y * sy,
        width: r.width * sx,
        height: r.height * sy,
      });
      // An in-flight gesture must rescale too, or its stale anchor /
      // last-point drags the marquee to the wrong region (round-2).
      const active = interactionRef.current;
      if (active?.type === 'draw') {
        interactionRef.current = {
          ...active,
          anchor: { x: active.anchor.x * sx, y: active.anchor.y * sy },
        };
      } else if (active?.type === 'move') {
        interactionRef.current = {
          ...active,
          last: { x: active.last.x * sx, y: active.last.y * sy },
        };
      } else if (active?.type === 'resize') {
        const c = active.capture;
        const horizontal = c.handle === 'e' || c.handle === 'w';
        interactionRef.current = {
          ...active,
          capture: {
            ...c,
            anchor: { x: c.anchor.x * sx, y: c.anchor.y * sy },
            cross: horizontal
              ? { start: c.cross.start * sy, size: c.cross.size * sy }
              : { start: c.cross.start * sx, size: c.cross.size * sx },
          },
        };
      }
    }
    measuredSrcRef.current = src;
    prevBoxRef.current = next;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setNaturalSize((prevNat) =>
        prevNat &&
        prevNat.width === img.naturalWidth &&
        prevNat.height === img.naturalHeight
          ? prevNat
          : { width: img.naturalWidth, height: img.naturalHeight },
      );
    }
    setBox(next);
  }, [nodeId]);

  // Switching the crop target discards the in-progress marquee. A LAYOUT
  // effect declared BEFORE the measure effect: layout effects run in
  // declaration order, so the reset nulls the src baseline first and the
  // measure below immediately re-records it for the new target — a passive
  // reset used to run AFTER the mount measure and wipe the baseline, which
  // silently disabled the confirm-time src-swap check (adversarial R2).
  React.useLayoutEffect(() => {
    setRect(null);
    setRatio(null);
    interactionRef.current = null;
    measuredSrcRef.current = null;
    // The geometry baseline must die with the target too — a surviving
    // prevBox let the measure's rescale branch resurrect the PREVIOUS
    // node's marquee re-projected onto the new image (round-3, HIGH).
    prevBoxRef.current = null;
    lastImgElRef.current = null;
    // The previous target's ResizeObserver must die with it (round-4) —
    // measure() rebinds a fresh one for the new target's img.
    resizeObsRef.current?.disconnect();
    resizeObsRef.current = null;
  }, [nodeId]);

  // Re-measure on mount, on any viewport change, on node drag, on window
  // resize — and on IMG layout/content changes the other signals miss (a
  // collaborator resizing the node or a regenerate swapping the content
  // never touches the local transform / nodePosition).
  React.useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    // Observe the node CONTAINER, not the img (round-3): a handling cycle
    // REMOUNTS the img, permanently killing element-bound observers.
    // childList catches the remount, attributes catches both the src swap
    // (same-size regenerate, round-2) and node style resizes; the
    // measure-managed ResizeObserver rebinds itself per img identity.
    const container = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`,
    );
    const mo = container ? new MutationObserver(measure) : null;
    if (mo && container) {
      mo.observe(container, { childList: true, subtree: true, attributes: true });
    }
    return () => {
      window.removeEventListener('resize', measure);
      mo?.disconnect();
    };
  }, [measure, transform, nodePosition.x, nodePosition.y, nodeId]);


  // Disconnect the measure-managed ResizeObserver on FINAL unmount only —
  // the measure effect's cleanup runs on every transform change and must
  // not tear down an observer that outlives it.
  React.useEffect(
    () => () => {
      resizeObsRef.current?.disconnect();
    },
    [],
  );

  // Esc: clear the marquee first; with nothing drawn, exit the session.
  // Bubble phase, never capture (adversarial 2026-07-16: a window CAPTURE
  // listener with stopPropagation stole Esc from every popover / the @
  // suggestion while the overlay was mounted). Surfaces that own their own
  // Esc get priority two ways: a handler that preventDefault()s wins, and
  // focus inside an editor / open overlay content skips us entirely.
  React.useEffect(() => {
    /**
     * Keydown listener implementing the two-stage Esc behavior.
     * @param e - The keyboard event.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      // isComposing / 229: an IME composition-cancel Escape must never
      // leak into the session handlers (round-11 — a CJK user dismissing
      // the candidate window lost their marquee).
      // Every consumer that preventDefaults owns the press — including an
      // open Radix tooltip dismissing itself (adversarial round-2 reversal:
      // a [role=tooltip]-presence bypass misattributed OTHER consumers'
      // preventDefault — rename editors, the @-suggestion — whenever a
      // tooltip happened to be open, double-acting on one press; the single
      // defaultPrevented bit cannot say WHO consumed). Layered peel: the
      // tooltip visibly dismisses on its press, the next press acts here.
      if (
        e.key !== 'Escape' ||
        e.defaultPrevented ||
        e.repeat ||
        e.isComposing ||
        e.keyCode === 229
      ) {
        return;
      }
      const active = document.activeElement;
      // Yield by Esc OWNERSHIP, not focus location (round-6): consumers
      // (the @-suggestion, Radix overlays) preventDefault or hold focus in
      // overlay content; a plain focused prompt editor consumes nothing,
      // and yielding to it left Esc silently dead there.
      if (
        active &&
        active.closest(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
        ) !== null
      ) {
        return;
      }
      if (
        boxStateRef.current !== null &&
        (rectRef.current || interactionRef.current)
      ) {
        // Stage one also aborts an in-progress gesture — without this the
        // captured pointer's next move instantly recreated the rect, so
        // Esc mid-drag never stuck (adversarial round-2). Stage one only
        // applies while the marquee is VISIBLE (round-9): with the target
        // culled off-viewport, Esc would silently eat the kept selection
        // and look dead — it peels back to the pick state instead.
        interactionRef.current = null;
        setRect(null);
      } else {
        // Stage two = back to the pick state, aligned with Cancel (user
        // 2026-07-17): the session survives; a further Esc in the pick
        // state exits via the canvas-level handler.
        handOffFocusToPickBanner(rootRef.current);
        onBackToPick();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onBackToPick]);

  // The root ALWAYS renders (measure needs its rect — a null-return here
  // would never mount the ref and the overlay could never appear); the
  // interactive layers below render only once the img box is measured.
  const bounds = box
    ? { width: box.width, height: box.height }
    : { width: 0, height: 0 };

  /**
   * Pointer position in the img box's local pixel space.
   * @param e - The pointer event.
   * @returns Local coordinates relative to the image box.
   */
  const localPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const rootRect = rootRef.current!.getBoundingClientRect();
    return {
      x: e.clientX - rootRect.left - (box?.x ?? 0),
      y: e.clientY - rootRect.top - (box?.y ?? 0),
    };
  };

  /**
   * Begin a marquee draw from an empty area of the capture layer.
   * @param e - The pointer-down event.
   */
  const onLayerPointerDown = (e: React.PointerEvent): void => {
    // A second touch mid-interaction must not hijack / destroy the marquee
    // (adversarial 2026-07-16): the first pointer owns the gesture.
    if (e.button !== 0 || interactionRef.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = localPoint(e);
    interactionRef.current = { type: 'draw', anchor: p, pointerId: e.pointerId };
    setRect(drawRect(p, p, bounds, ratio));
  };

  /**
   * Begin moving the existing marquee (pointer-down on its body).
   * @param e - The pointer-down event.
   */
  const onRectPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || interactionRef.current) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    interactionRef.current = {
      type: 'move',
      last: localPoint(e),
      pointerId: e.pointerId,
    };
  };

  /**
   * Begin resizing via a handle.
   * @param handle - The grabbed handle.
   * @returns The pointer-down handler for that handle.
   */
  const onHandlePointerDown =
    (handle: CropHandle) =>
      (e: React.PointerEvent): void => {
        if (e.button !== 0 || interactionRef.current || !rectRef.current) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        // Freeze the anchor NOW (round-9): re-deriving it from the mutated
        // rect on every move lost its identity after an anchor crossing —
        // the fixed edge chased the cursor into a sliver.
        interactionRef.current = {
          type: 'resize',
          capture: captureResize(rectRef.current, handle),
          pointerId: e.pointerId,
        };
      };

  /**
   * Route pointer movement to the active interaction's pure-math update.
   * @param e - The pointer-move event.
   */
  const onPointerMove = (e: React.PointerEvent): void => {
    const interaction = interactionRef.current;
    if (!interaction || e.pointerId !== interaction.pointerId) return;
    const p = localPoint(e);
    if (interaction.type === 'draw') {
      setRect(drawRect(interaction.anchor, p, bounds, ratio));
    } else if (interaction.type === 'move') {
      const { last } = interaction;
      interactionRef.current = { type: 'move', last: p, pointerId: interaction.pointerId };
      setRect((prev) =>
        prev ? moveRect(prev, p.x - last.x, p.y - last.y, bounds) : prev,
      );
    } else {
      setRect(resizeFromCapture(interaction.capture, p, bounds, ratio));
    }
  };

  // Forward wheel over the overlay to the ReactFlow pane (round-5), via a
  // NATIVE NON-PASSIVE listener (round-6): d3-zoom's own pane listener is
  // non-passive and preventDefaults ctrl+wheel / trackpad pinch, which is
  // what suppresses the BROWSER's page zoom over the canvas — a React
  // onWheel binding is passive at the root by design, so the original
  // event's default ran and every mid-crop pinch page-zoomed the whole UI
  // on top of the canvas zoom. preventDefault the ORIGINAL, then drive
  // d3-zoom with a cancelable clone; the transform change re-measures and
  // rescales the marquee through the normal path.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    /**
     * Native wheel forwarder: suppress the browser default, drive d3-zoom.
     * @param e - The original (trusted) wheel event.
     */
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) return;
      pane.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: e.clientX,
          clientY: e.clientY,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          shiftKey: e.shiftKey,
        }),
      );
    };
    // Bound to the overlay ROOT (round-7): the capture layer AND the
    // controls bar bubble here, so one listener covers every interactive
    // surface — the round-6 layer-only binding left pinch over the bar
    // page-zooming the browser. The root is pointer-events-none, so wheels
    // over empty overlay area never target it and pass to the canvas.
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, []);

  /**
   * Finish the active interaction (pointer up / cancel) — only the owning
   * pointer may end it (a resting second finger lifting must not).
   * @param e - The pointer-up / cancel event.
   */
  const onPointerUp = (e: React.PointerEvent): void => {
    const interaction = interactionRef.current;
    if (interaction && e.pointerId !== interaction.pointerId) return;
    interactionRef.current = null;
    // Invariant (round-2 HIGH + round-3): NO gesture may end with a rect
    // Confirm cannot accept — a bare click's zero-size draw and a resize
    // collapsed onto its anchor both leave an invisible marquee that dims
    // the image, disables Confirm, and eats an Esc stage. Gauged with the
    // SAME zoom-independent validity as Confirm (round-9): the display
    // gauge was destroying a zoom-out-rescaled selection that Confirm
    // deliberately still accepted (round-8).
    if (interaction && rectRef.current) {
      const nat = naturalSizeRef.current;
      const b = prevBoxRef.current;
      const valid =
        nat && b
          ? isNaturalCropValid(rectRef.current, b, nat)
          : isCropValid(rectRef.current);
      if (!valid) setRect(null);
    }
    setTick((n) => n + 1);
  };

  /**
   * Apply (or clear, when re-clicked) a ratio preset.
   * @param value - The preset's width/height value.
   */
  const onRatioClick = (value: number): void => {
    const next = ratio === value ? null : value;
    setRatio(next);
    if (next !== null) {
      // The degenerate-rect invariant covers preset clicks too (round-4):
      // applyRatioPreset grows the seed to the minimum, but a tiny image
      // whose bounds cannot hold the minimum at this ratio yields an
      // invalid rect — discard it rather than strand a sub-minimum sliver.
      setRect((prev) => {
        if (!prev) return prev;
        // Seed the reshape with NATURAL-aware display minimums (round-11):
        // at zoom-in the natural gauge demands more display px than
        // MIN_CROP_PX, and a display-seeded reshape landed below the gauge
        // — a preset click destroyed a selection that a valid 16:9 rect
        // trivially fit.
        const minW =
          naturalSize && box
            ? Math.max(MIN_CROP_PX, (MIN_NATURAL_CROP_PX * box.width) / naturalSize.width)
            : MIN_CROP_PX;
        const minH =
          naturalSize && box
            ? Math.max(MIN_CROP_PX, (MIN_NATURAL_CROP_PX * box.height) / naturalSize.height)
            : MIN_CROP_PX;
        const shaped = applyRatioPreset(prev, next, bounds, minW, minH);
        // The THIRD validity decision joins the unified gauge (round-10):
        // display-px here was eating a zoom-out selection that pointer-up
        // and Confirm deliberately accept.
        const valid =
          naturalSize && box
            ? isNaturalCropValid(shaped, box, naturalSize)
            : isCropValid(shaped);
        return valid ? shaped : null;
      });
    }
  };

  /** Confirm the current marquee: map to natural pixels and hand off. */
  const onConfirmClick = (): void => {
    if (!rect || box === null) return;
    if (naturalSize ? !isNaturalCropValid(rect, box, naturalSize) : !isCropValid(rect)) {
      return;
    }
    const img = document.querySelector(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"] [data-testid=image-node-img]`,
    );
    // Confirm-time swap check (round-2): the MutationObserver discards the
    // marquee live, but a swap can still land between the last measure and
    // this click — never crop NEW content at OLD marquee coordinates.
    if (
      img instanceof HTMLImageElement &&
      measuredSrcRef.current !== null &&
      img.getAttribute('src') !== measuredSrcRef.current
    ) {
      setRect(null);
      toast.warning(t('canvas.generatePanel.focusSourceChanged'));
      return;
    }
    if (!(img instanceof HTMLImageElement) || img.naturalWidth === 0) {
      // The source exists but is not decodable yet (new bitmap loading /
      // broken URL) — say so instead of a silent dead button (round-2);
      // the marquee stays so a loaded image can be confirmed on retry.
      toast.error(t('canvas.generatePanel.focusExportFailed'));
      return;
    }
    if (measuredSrcRef.current === null) {
      // No validated baseline (img never carried a src) — same treatment
      // as a not-yet-decodable source.
      toast.error(t('canvas.generatePanel.focusExportFailed'));
      return;
    }
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    const accepted = onConfirm({
      crop: toNaturalCrop(rect, bounds, natural),
      natural,
      sourceSrc: measuredSrcRef.current,
    });
    // A gate rejection (pool full, source gone) keeps the marquee — the
    // user's careful selection must survive a fixable rejection (round-3).
    if (accepted) {
      // Clearing the rect disables the focused Confirm button, which drops
      // DOM focus to <body> (round-5) — hand it to Cancel synchronously
      // (still enabled, same bar) so keyboard users stay in the session.
      // A second pointer's in-flight gesture dies too (round-11), or its
      // next move resurrects the cleared marquee.
      interactionRef.current = null;
      cancelRef.current?.focus();
      setRect(null);
    }
  };

  // Confirm validity is zoom-INDEPENDENT (round-8): a zoom-out rescale
  // shrinks a valid selection below the display minimum without changing
  // the natural region it selects — gauge by natural pixels when known.
  const confirmDisabled =
    rect === null ||
    box === null ||
    (naturalSize
      ? !isNaturalCropValid(rect, box, naturalSize)
      : !isCropValid(rect));

  const cancelRef = React.useRef<HTMLButtonElement>(null);

  return (
    <div
      ref={rootRef}
      data-testid='focus-crop-overlay'
      className='pointer-events-none absolute inset-0 z-10'
    >
      {box === null ? null : (
        <>
          {/* Capture layer over the image: draws the marquee, eats canvas gestures. */}
          <div
            data-testid='focus-crop-layer'
            className='pointer-events-auto absolute touch-none cursor-crosshair'
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
            onPointerDown={onLayerPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {rect ? (
              <div
                data-testid='focus-crop-rect'
                className='absolute cursor-move border border-background outline outline-1 outline-foreground'
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                  boxShadow: '0 0 0 100000px rgb(0 0 0 / 0.4)',
                }}
                onPointerDown={onRectPointerDown}
              >
                {HANDLES.map(({ id, className }) => (
                  <div
                    key={id}
                    data-testid={`focus-crop-handle-${id}`}
                    className={`absolute h-2 w-2 rounded-full border border-foreground bg-background ${className}`}
                    onPointerDown={onHandlePointerDown(id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
          {/* Controls bar below the image: ratio presets + cancel / confirm. */}
          <div
            data-testid='focus-crop-controls'
            // rounded-overlay = the 6px chrome radius (user 2026-07-17 #3;
            // rounded-md is 12px in this theme).
            className='pointer-events-auto absolute flex -translate-x-1/2 items-center gap-1 rounded-overlay border border-border bg-card px-2 py-1.5 text-xs text-foreground shadow-md'
            // Anchored under the picked node like the generate panel (user
            // 2026-07-17): always centered below the img box, allowed to
            // overflow the viewport — the earlier viewport clamp pulled the
            // bar away from an edge-parked node.
            style={{
              left: box.x + box.width / 2,
              top: box.y + box.height + 8,
            }}
          >
            {CROP_RATIOS.map(({ key, value }) => (
              <button
                key={key}
                type='button'
                data-testid={`focus-ratio-${key}`}
                aria-pressed={ratio === value}
                onClick={() => onRatioClick(value)}
                // whitespace-nowrap + shrink-0 (user 2026-07-17 #1): an
                // abspos bar near the viewport edge shrink-to-fits against
                // the available width, and without these the CJK button
                // labels wrapped one character per line.
                className={
                  'shrink-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 tabular-nums transition-colors ' +
              (ratio === value
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground')
                }
              >
                {key}
              </button>
            ))}
            <span aria-hidden='true' className='mx-1 h-4 w-px bg-border' />
            <button
              ref={cancelRef}
              type='button'
              data-testid='focus-crop-cancel'
              onClick={() => {
                // Cancel aborts the in-flight gesture too (round-11) — the
                // captured pointer's next move resurrected the marquee —
                // then returns to the PICK state (user 2026-07-17 A): the
                // banner stays and another image can be picked.
                interactionRef.current = null;
                setRect(null);
                handOffFocusToPickBanner(rootRef.current);
                onBackToPick();
              }}
              className='shrink-0 whitespace-nowrap rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            >
              {t('canvas.generatePanel.focusCancel')}
            </button>
            <button
              type='button'
              data-testid='focus-crop-confirm'
              onClick={onConfirmClick}
              disabled={confirmDisabled}
              className='shrink-0 whitespace-nowrap rounded-sm bg-foreground px-2 py-0.5 text-background disabled:cursor-not-allowed disabled:opacity-50'
            >
              {t('canvas.generatePanel.focusConfirm')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
