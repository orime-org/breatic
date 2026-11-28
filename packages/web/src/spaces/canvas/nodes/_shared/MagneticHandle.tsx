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
/** At rest the plus's near edge stands this far out from the border, on screen. */
const PLUS_GAP_SCREEN_PX = 4;

/**
 * The press zone of an emphasized handle, `--handle-zone` canvas px square
 * from the border outward: the plain zone's 36px on screen, so the plus
 * sitting wholly outside the node has room to follow the pointer. `z-21`
 * lifts it above the video node's playback-error cover (`z-20`, VideoNode)
 * and its control bar (`z-10`, MediaPlayer), which share the node's
 * stacking context.
 */
const EMPHASIZED_ZONE_CLASS = 'z-21 before:h-[var(--handle-zone)] before:w-[var(--handle-zone)]';

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
   * connections (inner#2216). The plus rests just outside the border and
   * follows the pointer inside its zone without crossing into the node; every
   * gesture behaves as on the plain dot and the wire stays attached to the
   * border.
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
  // Where the visible mark's centre may go, in canvas px out from the border:
  // the dot rests on the border; the plus rests its gap away and never
  // crosses the border, inside a zone kept 36px on screen.
  const plusRadius = (PLUS_SCREEN_PX / 2) * scale;
  const zone = plus ? ZONE_OUT_PX * Math.max(1, scale) : ZONE_OUT_PX;
  const restOut = plus ? PLUS_GAP_SCREEN_PX * scale + plusRadius : 0;
  const minOut = plus ? plusRadius : 0;
  const maxOut = plus ? zone - plusRadius : MAX_OUT;
  const maxV = plus ? Math.max(0, zone / 2 - plusRadius) : MAX_V;
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
      // Outward only: the mark never crosses inward past the border into the
      // node. `out` is the centre's distance out from the border.
      const out = clamp(type === 'source' ? rawX : -rawX, minOut, maxOut);
      // `+ 0` turns a clamped -0 into 0 so the transform reads `0px`.
      const dx = (type === 'source' ? out - restOut : restOut - out) + 0;
      const dy = clamp(rawY, -maxV, maxV) + 0;
      dot.style.transform = `translate(${dx}px, ${dy}px)`;
    },
    [isConnectable, connecting, type, minOut, maxOut, maxV, restOut],
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
  const sideZoneClass =
    type === 'source'
      ? '!h-2 !w-2 !right-1 !border-0 !bg-transparent before:absolute before:left-2 before:top-1/2 before:-translate-y-1/2 before:content-[""]'
      : '!h-2 !w-2 !left-1 !border-0 !bg-transparent before:absolute before:top-1/2 before:-translate-y-1/2 before:content-[""]';
  // A target's zone ends at the border, so it starts its own width left of it.
  const zoneClass = plus
    ? `${sideZoneClass} ${EMPHASIZED_ZONE_CLASS}${type === 'source' ? '' : ' before:left-[calc(var(--handle-zone)*-1)]'}`
    : `${sideZoneClass} before:h-9 before:w-9${type === 'source' ? '' : ' before:-left-9'}`;

  // The 8px dot, offset +4px OUTWARD from the anchor so its centre straddles the
  // border (source left-1, target -left-1) — the anchor's outer edge is the
  // border, and half the dot sits each side of it. It springs further out via
  // transform (written by `chase`), back to this base on rest. The emphasized
  // dot keeps the same chase box and draws nothing itself; the plus inside it
  // is the visual.
  const dotClass = `pointer-events-none absolute inset-y-0 w-2 transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] ${
    plus ? '' : 'rounded-full border border-border bg-muted '
  }${type === 'source' ? 'left-1' : '-left-1'}`;
  const handleStyle = React.useMemo<React.CSSProperties | undefined>(
    () =>
      plus
        ? ({
          '--handle-zone': `${zone}px`,
        } as React.CSSProperties)
        : undefined,
    [plus, zone],
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
      className={hidden ? `${zoneClass} !invisible` : zoneClass}
      style={handleStyle}
    >
      {/* Visible dot: centre straddles the border, springs toward the cursor. */}
      {hidden ? null : (
        <span
          ref={dotRef}
          data-testid='handle-dot'
          aria-hidden='true'
          className={dotClass}
        >
          {plus ? (
            // At rest its gap out from the border, wholly outside the node;
            // the chase moves the dot around it.
            <span
              data-testid='handle-plus'
              className='absolute left-1/2 top-1/2 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-foreground'
              style={{
                transform: `translate(calc(-50% + ${type === 'source' ? restOut : -restOut}px), -50%) scale(${scale})`,
              }}
            >
              <Plus className='size-3.5' aria-hidden='true' />
            </span>
          ) : null}
        </span>
      )}
    </Handle>
  );
}
