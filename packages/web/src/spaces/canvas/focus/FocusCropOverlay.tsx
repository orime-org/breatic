// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { useStore } from '@xyflow/react';
import { toast } from 'sonner';

import { useTranslation } from '@web/i18n/use-translation';
import {
  CROP_RATIOS,
  drawRect,
  isCropValid,
  moveRect,
  resizeRect,
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
  /** Exit the whole focus session (Esc with no marquee). */
  onExit: () => void;
}

/** An in-progress pointer interaction on the marquee layer. */
type Interaction = { pointerId: number } & (
  | { type: 'draw'; anchor: { x: number; y: number } }
  | { type: 'move'; last: { x: number; y: number } }
  | { type: 'resize'; handle: CropHandle }
);

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
 * @param root0.onExit - Exits the focus session (Esc with no marquee).
 * @returns The overlay, or null until the target img is measurable.
 */
export function FocusCropOverlay({
  nodeId,
  nodePosition,
  onConfirm,
  onExit,
}: FocusCropOverlayProps): React.JSX.Element | null {
  const t = useTranslation();
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Viewport transform — any pan / zoom re-measures the image box.
  const transform = useStore((s) => s.transform);
  const [box, setBox] = React.useState<CropRect | null>(null);
  const [rootSize, setRootSize] = React.useState<{ width: number; height: number } | null>(null);
  const [rect, setRect] = React.useState<CropRect | null>(null);
  const [ratio, setRatio] = React.useState<number | null>(null);
  const interactionRef = React.useRef<Interaction | null>(null);
  // Force a state tick on interaction end so the controls bar re-evaluates.
  const [, setTick] = React.useState(0);
  // Mirror of `rect` for listeners that must read it without re-binding.
  const rectRef = React.useRef<CropRect | null>(null);
  rectRef.current = rect;
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
      // The target's <img> vanished (node deleted / flipped to handling):
      // the marquee, the in-flight gesture, and every baseline die with it
      // (round-5 — the third discard path gets the same abort as its two
      // siblings; a stale rect here re-anchored onto the REGENERATED image
      // when the img came back).
      interactionRef.current = null;
      setRect(null);
      measuredSrcRef.current = null;
      prevBoxRef.current = null;
      lastImgElRef.current = null;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      setBox(null);
      return;
    }
    if (lastImgElRef.current !== img) {
      if (lastImgElRef.current !== null) {
        // The img REMOUNTED (handling cycle / regenerate): the marquee and
        // baselines belong to the dead element — start fresh (round-3).
        // The in-flight gesture dies with it (round-4): a live draw's next
        // pointermove would instantly resurrect the discarded rect from a
        // stale, never-rescaled anchor (the Esc stage-one lesson).
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
    setRootSize({ width: rootRect.width, height: rootRect.height });
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
      }
    }
    measuredSrcRef.current = src;
    prevBoxRef.current = next;
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
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const active = document.activeElement;
      // Yield by Esc OWNERSHIP, not focus location (round-6): consumers
      // (the @-suggestion, Radix overlays) preventDefault or hold focus in
      // overlay content; a plain focused prompt editor consumes nothing,
      // and yielding to it left Esc silently dead there.
      if (
        active &&
        active.closest('[role="dialog"],[role="menu"],[role="listbox"]') !==
          null
      ) {
        return;
      }
      if (rectRef.current || interactionRef.current) {
        // Stage one also aborts an in-progress gesture — without this the
        // captured pointer's next move instantly recreated the rect, so
        // Esc mid-drag never stuck (adversarial round-2).
        interactionRef.current = null;
        setRect(null);
      } else {
        onExit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onExit]);

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
        if (e.button !== 0 || interactionRef.current) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        interactionRef.current = { type: 'resize', handle, pointerId: e.pointerId };
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
      setRect((prev) =>
        prev ? resizeRect(prev, interaction.handle, p, bounds, ratio) : prev,
      );
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
  const layerRef = React.useRef<HTMLDivElement>(null);
  const hasBox = box !== null;
  React.useEffect(() => {
    const layer = layerRef.current;
    if (!layer || !hasBox) return;
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
    layer.addEventListener('wheel', onWheel, { passive: false });
    return () => layer.removeEventListener('wheel', onWheel);
  }, [hasBox]);

  /**
   * Finish the active interaction (pointer up / cancel) — only the owning
   * pointer may end it (a resting second finger lifting must not).
   * @param e - The pointer-up / cancel event.
   */
  const onPointerUp = (e: React.PointerEvent): void => {
    const interaction = interactionRef.current;
    if (interaction && e.pointerId !== interaction.pointerId) return;
    interactionRef.current = null;
    // Invariant (round-2 HIGH + round-3): NO gesture may end with a
    // non-null sub-minimum rect — a bare click's zero-size draw and a
    // resize collapsed onto its anchor both leave an invisible marquee
    // that dims the image, disables Confirm, and eats an Esc stage.
    if (interaction && rectRef.current && !isCropValid(rectRef.current)) {
      setRect(null);
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
        const shaped = applyRatioPreset(prev, next, bounds);
        return isCropValid(shaped) ? shaped : null;
      });
    }
  };

  /** Confirm the current marquee: map to natural pixels and hand off. */
  const onConfirmClick = (): void => {
    if (!rect || !isCropValid(rect)) return;
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
      cancelRef.current?.focus();
      setRect(null);
    }
  };

  const confirmDisabled = rect === null || !isCropValid(rect);

  // Measured controls-bar size for the viewport clamp (round-3: a guessed
  // half-width let the Confirm end of a ~400px bar overflow the canvas at
  // the edges). State-guarded write per commit; jsdom (offsetWidth 0)
  // keeps the defaults.
  const barRef = React.useRef<HTMLDivElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const [barSize, setBarSize] = React.useState({ width: 360, height: 36 });
  React.useLayoutEffect(() => {
    const w = barRef.current?.offsetWidth ?? 0;
    const h = barRef.current?.offsetHeight ?? 0;
    if (w > 0 && (w !== barSize.width || h !== barSize.height)) {
      setBarSize({ width: w, height: h });
    }
    // box: the bar (re)mounts with the measured layers; ratio: the pressed
    // preset changes button styling. The size-diff guard above makes any
    // extra run a no-op, never a loop.
  }, [box, ratio, barSize.width, barSize.height]);

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
            ref={layerRef}
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
            ref={barRef}
            data-testid='focus-crop-controls'
            className='pointer-events-auto absolute flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground shadow-md'
            // Clamped into the canvas viewport with the bar's MEASURED size
            // (round-3): an image at the fold / the edge must never push the
            // Confirm end out of reach.
            style={{
              left: rootSize
                ? Math.min(
                  Math.max(box.x + box.width / 2, barSize.width / 2 + 8),
                  rootSize.width - barSize.width / 2 - 8,
                )
                : box.x + box.width / 2,
              top: rootSize
                ? Math.max(
                  8,
                  Math.min(
                    box.y + box.height + 8,
                    rootSize.height - barSize.height - 8,
                  ),
                )
                : box.y + box.height + 8,
            }}
          >
            {CROP_RATIOS.map(({ key, value }) => (
              <button
                key={key}
                type='button'
                data-testid={`focus-ratio-${key}`}
                aria-pressed={ratio === value}
                onClick={() => onRatioClick(value)}
                className={
                  'rounded-sm px-1.5 py-0.5 tabular-nums transition-colors ' +
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
              onClick={() => setRect(null)}
              className='rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            >
              {t('canvas.generatePanel.focusCancel')}
            </button>
            <button
              type='button'
              data-testid='focus-crop-confirm'
              onClick={onConfirmClick}
              disabled={confirmDisabled}
              className='rounded-sm bg-foreground px-2 py-0.5 text-background disabled:cursor-not-allowed disabled:opacity-50'
            >
              {t('canvas.generatePanel.focusConfirm')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
