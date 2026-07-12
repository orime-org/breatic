// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import * as React from 'react';

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
 * @returns The magnetic handle.
 */
export function MagneticHandle({
  type,
  isConnectable,
}: MagneticHandleProps): React.JSX.Element {
  const handleRef = React.useRef<HTMLDivElement>(null);
  const dotRef = React.useRef<HTMLSpanElement>(null);
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
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const rawX = (event.clientX - cx) / zoom;
      const rawY = (event.clientY - cy) / zoom;
      // Outward only: a source dot never crosses inward past the border (into
      // the node), a target dot never crosses outward past it.
      const dx =
        type === 'source' ? clamp(rawX, 0, MAX_OUT) : clamp(rawX, -MAX_OUT, 0);
      const dy = clamp(rawY, -MAX_V, MAX_V);
      dot.style.transform = `translate(${dx}px, ${dy}px)`;
    },
    [isConnectable, connecting, type],
  );

  // The 8px element is invisible (bg-transparent, border-0); the visual is the
  // dot child. The ::before is the 36px outside-the-border hit zone.
  //
  // Border-pinned anchor (user 2026-07-12 P1): xyflow attaches the edge at the
  // handle's OUTER edge (Position.Right → x + width), so an 8px handle CENTERED
  // on the border put the wire 4px OUTSIDE it — a visible gap. `!right-1` /
  // `!left-1` shift the anchor 4px inward so its outer edge (the attachment
  // point) sits ON the border and the wire is flush against it. The dot then
  // rests just inside the border (covering the attachment) and springs OUTWARD
  // past it (leaving the node — an accepted look). The ::before offsets gain
  // +4px (source left-1→left-2, target -left-8→-left-9) so the 36px zone still
  // spans exactly the border → border+36 outside. Vertically centered
  // (top-1/2 + -translate-y-1/2).
  const zoneClass =
    type === 'source'
      ? '!h-2 !w-2 !right-1 !border-0 !bg-transparent before:absolute before:left-2 before:top-1/2 before:h-9 before:w-9 before:-translate-y-1/2 before:content-[""]'
      : '!h-2 !w-2 !left-1 !border-0 !bg-transparent before:absolute before:-left-9 before:top-1/2 before:h-9 before:w-9 before:-translate-y-1/2 before:content-[""]';

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
      className={zoneClass}
    >
      {/* Visible dot: fills the 8px anchor (inset-0 = centered on the border),
          springs toward the cursor via transform with overshoot easing. */}
      <span
        ref={dotRef}
        data-testid='handle-dot'
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 rounded-full border border-border bg-muted transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]'
      />
    </Handle>
  );
}
