// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Magnetic connection handle (user 2026-07-11). Three DECOUPLED layers so the
 * dot can spring toward the cursor without moving the wire attachment point:
 *
 *   1. ANCHOR — the 8px `<Handle>` element itself, invisible, shifted 4px inward
 *      (!right-1 / !left-1) so its OUTER edge — the point xyflow attaches the
 *      edge to (Position.Right → x + width) — sits ON the node border, flush,
 *      no gap (user 2026-07-12 P1). The wire always starts/ends here regardless
 *      of where the visible dot has drifted.
 *   2. HIT ZONE — a 36×36 `::before` pseudo fully OUTSIDE the border (source
 *      reaches right, target reaches left). Pointer events on the pseudo
 *      forward to the parent, so the whole zone triggers connect gestures.
 *   3. VISIBLE DOT — a child span that, while the cursor is in the zone,
 *      spring-follows it (transform written via ref, no React state churn —
 *      pointermove fires constantly) with an overshoot easing. It springs
 *      back to the border on leave and the instant a connection drag starts.
 */

import { Handle, Position, useStore } from '@xyflow/react';
import { Plus } from 'lucide-react';
import * as React from 'react';

import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';

/** The anchor element (and the dot) are 8px — matches the historic handle dot. */
const ANCHOR_PX = 8;
/** Dot radius, used to keep the dot fully inside the zone while chasing. */
const DOT_RADIUS = ANCHOR_PX / 2;
/** The hit zone reaches this far OUTWARD from the border (36px zone). */
const ZONE_OUT_PX = 36;
/** Max outward travel of the dot CENTER (keeps the whole dot inside the zone). */
const MAX_OUT = ZONE_OUT_PX - DOT_RADIUS;
/** Max vertical travel of the dot center (zone is 36 tall = ±18 from border). */
const MAX_V = ZONE_OUT_PX / 2 - DOT_RADIUS;
/** The plus a lone selected node shows on its handles is this wide on screen. */
const PLUS_SCREEN_PX = 20;

/**
 * Stacking for an emphasized handle inside its node (inner#2216): above the
 * video node's playback-error cover (`z-20`, VideoNode) and its control bar
 * (`z-10`, MediaPlayer), which otherwise paint over the plus's inner half
 * because the handle shares the node's stacking context with them. The class
 * written below is the literal `z-21` so Tailwind can see it; the handle test
 * keeps the two in step.
 */
export const EMPHASIZED_HANDLE_Z = 21;

/**
 * The press zones of an emphasized handle, sized from `--handle-plus-r` (the
 * plus's radius in canvas px). The outward `::before` grows tall enough to
 * hold the plus; the `::after` is a circle of the plus's size centred on the
 * border, so the plus's inner half presses into a connection while the node
 * body above and below it does not (a press is clipped to the rounded edge).
 * `index.css` stands both down while a wire is dragged.
 */
const EMPHASIZED_ZONE_CLASS =
  'z-21 before:h-[max(36px,calc(var(--handle-plus-r)*2))] after:absolute after:top-1/2 after:h-[calc(var(--handle-plus-r)*2)] after:w-[calc(var(--handle-plus-r)*2)] after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:content-[""]';

/** The plain zone's height, replaced by the emphasized one above. */
const PLAIN_ZONE_HEIGHT = 'before:h-9';

/** Props for {@link MagneticHandle}. */
interface MagneticHandleProps {
  /** Which side: `source` reaches right, `target` reaches left. */
  type: 'source' | 'target';
  /**
   * Whether the handle accepts connections. Forwarded to all three xyflow
   * connectable flags — the gesture gates sit on Start/End, not the styling
   * flag, so a viewer / reference pick that drops any of them keeps handles
   * live (adversarial round-1). Also gates the spring: a dead handle stays put.
   */
  isConnectable: boolean;
  /**
   * Whether a tool drawing on the node's border has the handle give way: it
   * stays mounted, so the node's edges keep their anchor, but shows no dot and
   * takes no press.
   */
  hidden?: boolean;
  /**
   * Whether the handle shows the plus: the node is the one selected and takes
   * connections (inner#2216). Appearance and press area only; every gesture
   * behaves as on the plain dot.
   */
  emphasized?: boolean;
}

/**
 * Clamps a value into `[min, max]`.
 * @param v - The value.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The clamped value.
 */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * A connection handle whose visible dot magnetically springs toward the cursor
 * inside an enlarged outside-the-border hit zone, while the wire attachment
 * point stays fixed on the border.
 * @param root0 - Component props.
 * @param root0.type - `source` (right) or `target` (left).
 * @param root0.isConnectable - Whether the handle accepts connections.
 * @param root0.hidden - Whether the handle gives way to a tool on the node's border.
 * @param root0.emphasized - Whether the handle shows the plus.
 * @returns The magnetic handle.
 */
export function MagneticHandle({
  type,
  isConnectable: connectable,
  hidden = false,
  emphasized = false,
}: MagneticHandleProps): React.JSX.Element {
  const isConnectable = connectable && !hidden;
  const plus = emphasized && !hidden;
  const handleRef = React.useRef<HTMLDivElement>(null);
  const dotRef = React.useRef<HTMLSpanElement>(null);
  // The node's counter-scale (1 / max(zoom, floor)), the same one the name
  // header uses, so the plus keeps its screen size down to the floor zoom.
  const scale = React.useContext(NodeScaleContext);
  // The plus's radius in canvas px; the chase keeps the whole plus inside
  // the 36px zone, as it keeps the 4px-radius dot.
  const plusRadius = (PLUS_SCREEN_PX / 2) * scale;
  const maxOut = plus ? ZONE_OUT_PX - plusRadius : MAX_OUT;
  const maxV = plus ? Math.max(0, ZONE_OUT_PX / 2 - plusRadius) : MAX_V;
  // Whether ANY connection drag is in progress (boolean selector → this only
  // re-renders on the flip, not per pointer-move). Used to REST the dot during
  // a drag (cosmetic — a one-frame lag is invisible). The correctness-critical
  // half — standing the 36px ::before hit zone down so it cannot hijack
  // xyflow's elementFromPoint target resolution for a nearby node — is NOT
  // done here: a React class commits one frame too late, and xyflow resolves
  // the target synchronously in the SAME tick it starts the connection
  // (adversarial round-4). That gate is a synchronous class the canvas adds in
  // onConnectStart (see `.canvas-connecting .react-flow__handle::before` in
  // index.css), which elementFromPoint's style flush picks up immediately.
  const connecting = useStore((s) => s.connection.inProgress);

  /** Springs the dot back to the border (home) — leave / drag-start / dead. */
  const rest = React.useCallback((): void => {
    if (dotRef.current) dotRef.current.style.transform = '';
  }, []);

  // Declaratively rest the dot whenever it must not be displaced: a dead
  // handle (isConnectable false) or any connection drag. The transform is
  // written imperatively, so a re-render alone would not clear a dot already
  // sprung out when the state flips (adversarial round-3: it would freeze off
  // the border).
  React.useEffect(() => {
    if (!isConnectable || connecting) rest();
  }, [isConnectable, connecting, rest]);

  /**
   * Moves the dot toward the cursor, clamped inside the zone. Reads geometry
   * from the live rect (works at any zoom) and writes the transform directly —
   * pointermove fires per pixel, so routing this through React state would
   * thrash. The offset is in canvas px (screen offset / zoom); the viewport's
   * own scale renders it back to screen px, so the dot tracks the cursor 1:1.
   * @param event - The pointer move event.
   */
  const chase = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      // Dead handle, or a connection drag is in progress → the dot rests
      // (round-3: chasing mid-drag detached the dot from the wire endpoint).
      if (!isConnectable || connecting) return;
      const el = handleRef.current;
      const dot = dotRef.current;
      if (!el || !dot) return;
      const rect = el.getBoundingClientRect();
      const zoom = rect.width / ANCHOR_PX || 1;
      // Spring from the BORDER (the anchor's outer edge = the dot's rest centre,
      // which straddles the border — A, user 2026-07-12), NOT the anchor's own
      // centre: rect.right is the border for a source, rect.left for a target.
      // At the border the offset is 0, so the dot sits at rest straddling it.
      const cx = type === 'source' ? rect.right : rect.left;
      const cy = rect.top + rect.height / 2;
      const rawX = (event.clientX - cx) / zoom;
      const rawY = (event.clientY - cy) / zoom;
      // Outward only: a source dot never crosses inward past the border (into
      // the node), a target dot never crosses outward past it.
      const dx =
        type === 'source' ? clamp(rawX, 0, maxOut) : clamp(rawX, -maxOut, 0);
      // `+ 0` turns a clamped -0 into 0 so the transform reads `0px`.
      const dy = clamp(rawY, -maxV, maxV) + 0;
      dot.style.transform = `translate(${dx}px, ${dy}px)`;
    },
    [isConnectable, connecting, type, maxOut, maxV],
  );

  // The 8px element is invisible (bg-transparent, border-0); the visual is the
  // dot child. The ::before is the 36px outside-the-border hit zone.
  //
  // Border-pinned anchor (user 2026-07-12 P1): xyflow attaches the edge at the
  // handle's OUTER edge (Position.Right → x + width), so an 8px handle CENTERED
  // on the border put the wire 4px OUTSIDE it — a visible gap. `!right-1` /
  // `!left-1` shift the anchor 4px inward so its outer edge (the attachment
  // point) sits ON the border and the wire is flush against it. The visible dot
  // is offset back OUT by 4px (source left-1, target -left-1) so its CENTRE sits
  // ON the border, straddling it (user 2026-07-12 A — restores the pre-P1 look
  // where the dot midpoint is on the line, while keeping the wire flush). The
  // ::before offsets gain +4px (source left-1→left-2, target -left-8→-left-9) so
  // the 36px zone still spans exactly the border → border+36 outside. Vertically
  // centered (top-1/2 + -translate-y-1/2).
  const zoneClass =
    type === 'source'
      ? '!h-2 !w-2 !right-1 !border-0 !bg-transparent before:absolute before:left-2 before:top-1/2 before:h-9 before:w-9 before:-translate-y-1/2 before:content-[""]'
      : '!h-2 !w-2 !left-1 !border-0 !bg-transparent before:absolute before:-left-9 before:top-1/2 before:h-9 before:w-9 before:-translate-y-1/2 before:content-[""]';

  // The 8px dot, offset +4px OUTWARD from the anchor so its centre straddles the
  // border (source left-1, target -left-1) — the anchor's outer edge is the
  // border, and half the dot sits each side of it. It springs further out via
  // transform (written by `chase`), back to this base on rest.
  const dotBase =
    'pointer-events-none absolute inset-y-0 w-2 rounded-full border border-border bg-muted transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]';
  const dotClass =
    type === 'source' ? `${dotBase} left-1` : `${dotBase} -left-1`;
  // The emphasized dot keeps the chase box (same place, same transform) and
  // draws nothing itself; the plus inside it is the visual.
  const plusDotBase =
    'pointer-events-none absolute inset-y-0 w-2 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]';
  const plusDotClass =
    type === 'source' ? `${plusDotBase} left-1` : `${plusDotBase} -left-1`;
  // The ::after circle is centred on the border: the anchor's outer edge,
  // its right edge for a source (left-2 = 8px) and its left edge for a target.
  const plusZoneClass = `${zoneClass.replace(PLAIN_ZONE_HEIGHT, '')} ${EMPHASIZED_ZONE_CLASS} ${
    type === 'source' ? 'after:left-2' : 'after:left-0'
  }`;
  const handleClass = plus ? plusZoneClass : zoneClass;
  const handleStyle = React.useMemo<React.CSSProperties | undefined>(
    () =>
      plus
        ? ({ '--handle-plus-r': `${plusRadius}px` } as React.CSSProperties)
        : undefined,
    [plus, plusRadius],
  );

  return (
    <Handle
      ref={handleRef}
      type={type}
      position={type === 'source' ? Position.Right : Position.Left}
      isConnectable={isConnectable}
      isConnectableStart={isConnectable}
      isConnectableEnd={isConnectable}
      onPointerMove={chase}
      onPointerLeave={rest}
      onPointerDown={rest}
      className={hidden ? `${zoneClass} !invisible` : handleClass}
      style={handleStyle}
    >
      {/* Visible dot: centre straddles the border, springs toward the cursor. */}
      {hidden ? null : (
        <span
          ref={dotRef}
          data-testid='handle-dot'
          aria-hidden='true'
          className={plus ? plusDotClass : dotClass}
        >
          {plus ? (
            // Centred on the dot's centre; the counter-scale lives here so it
            // never shares `transform` with the chase written on the dot.
            <span
              data-testid='handle-plus'
              className='absolute left-1/2 top-1/2 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-foreground'
              style={{ transform: `translate(-50%, -50%) scale(${scale})` }}
            >
              <Plus className='size-3.5' aria-hidden='true' />
            </span>
          ) : null}
        </span>
      )}
    </Handle>
  );
}
