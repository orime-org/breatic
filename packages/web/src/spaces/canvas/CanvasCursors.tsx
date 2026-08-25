// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { ViewportPortal, useStore } from '@xyflow/react';
import type { Awareness } from 'y-protocols/awareness';
import * as React from 'react';

import { useCollaboratorNames } from '@web/features/collab-editor/collaborator-names-context';
import { userPaletteColor } from '@web/lib/user-color';
import { collectPointers, samePointers, type RemotePointer } from '@web/spaces/canvas/canvas-pointers';
import { overlayCounterScale } from '@web/spaces/canvas/overlay-scale';

/**
 * Stacking order for the cursor layer.
 *
 * `ViewportPortal` renders into `.react-flow__viewport-portal`, a sibling of
 * the node layer that carries no z-index of its own — and a positioned element
 * with a positive z-index paints over one with `auto` whatever the DOM order.
 * The canvas has several: a selected node sits at xyflow's default 1000, a
 * focus crop target at `FOCUS_TARGET_Z` (1002), a group member higher still.
 * Those are exactly the places a cursor most needs to be seen, so this clears
 * all of them with room to spare.
 *
 * It cannot escape the generate panel, and does not need to: the panel rides a
 * `NodeToolbar` that portals into `.react-flow__renderer`, outside the
 * viewport's stacking context.
 */
const CURSOR_LAYER_Z = 1100;

/** What the cursor layer needs to draw everyone else's pointer. */
export interface CanvasCursorsProps {
  /** Where the other connections' pointers are, in canvas coordinates. */
  pointers: readonly RemotePointer[];
  /** The canvas zoom, for the counter-scale. */
  zoom: number;
}

/**
 * One collaborator's arrow with their name below and to the right of its tip.
 * @param props - The component props.
 * @param props.name - The display name to show.
 * @param props.color - The identity hue, as a CSS colour reference.
 * @returns The arrow and its name block.
 */
function Cursor({ name, color }: { name: string; color: string }): React.JSX.Element {
  return (
    <>
      <svg
        width='16'
        height='21'
        viewBox='0 0 16 21'
        fill={color}
        aria-hidden='true'
        className='block'
      >
        <path d='M0.5 0.5 L15 14 Q10 13.2 8.1 14.6 Q5.9 16.2 4.1 20 Q1.9 10 0.5 0.5 Z' />
      </svg>
      <span
        className='absolute top-6 left-[15px] max-w-[132px] overflow-hidden rounded-chrome px-2 py-[3px] text-xs font-semibold text-ellipsis whitespace-nowrap text-[color:var(--color-on-palette)]'
        style={{ backgroundColor: color }}
      >
        {name}
      </span>
    </>
  );
}

/**
 * Everyone else's pointer, drawn on the canvas where they are.
 *
 * The layer lives in xyflow's viewport portal, so pan and zoom carry it along
 * with the nodes; each cursor then counter-scales to keep a constant screen
 * size, the same way the node name headers and the edge scissors do.
 *
 * Someone the roster cannot name is left out: an anonymous arrow says a person
 * is there without saying who, which is the one thing the layer exists for.
 * @param props - The component props.
 * @param props.pointers - Where the peers are, in canvas coordinates.
 * @param props.zoom - The canvas zoom the counter-scale works from.
 * @returns The cursor layer, or null when nobody else is pointing at anything.
 */
export function CanvasCursors({ pointers, zoom }: CanvasCursorsProps): React.JSX.Element | null {
  const names = useCollaboratorNames();

  const drawable = React.useMemo(() => {
    const resolve = names?.resolve;
    if (!resolve) return [];
    // `resolve` answers null for someone the roster cannot name — a member who
    // left, or a roster still loading. `flatMap` drops those and narrows the
    // name to a string for everyone that is left.
    //
    // The dependency is the whole roster bundle, not the resolver: the
    // resolver's reference is stable for the component's lifetime by design
    // (`useResolverRef`), so keying on it would freeze these names at whatever
    // the roster held the first time.
    return pointers.flatMap((pointer) => {
      const name = resolve(pointer.userId);
      return name ? [{ ...pointer, name }] : [];
    });
  }, [pointers, names]);

  if (drawable.length === 0) return null;

  const scale = overlayCounterScale(zoom);

  return (
    <ViewportPortal>
      <div
        data-testid='canvas-cursors'
        className='pointer-events-none absolute top-0 left-0'
        style={{ zIndex: CURSOR_LAYER_Z }}
      >
        {drawable.map((pointer) => (
          <div
            // Keyed by connection, the only unique value here: one account in
            // two tabs publishes two pointers under one user id.
            key={pointer.clientId}
            data-testid={`canvas-cursor-${pointer.clientId}`}
            className='absolute top-0 left-0 origin-top-left'
            style={{ transform: `translate(${pointer.x}px, ${pointer.y}px) scale(${scale})` }}
          >
            <Cursor name={pointer.name} color={userPaletteColor(pointer.userId)} />
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}

/**
 * Follow every peer's pointer and draw them.
 *
 * The subscription lives here rather than in the canvas body on purpose: a
 * moving pointer produces an awareness change up to thirty times a second, and
 * whatever component holds that subscription re-renders each time. Held here,
 * those renders reach the cursors and nothing else — the node mirror reads the
 * damped table from `useCanvasOccupants` instead.
 * @param props - The component props.
 * @param props.awareness - This space's awareness, or null before it attaches.
 * @returns The cursor layer.
 */
export function CanvasCursorLayer({
  awareness,
}: {
  awareness: Awareness | null;
}): React.JSX.Element | null {
  const zoom = useStore((s) => s.transform[2]);
  const [pointers, setPointers] = React.useState<readonly RemotePointer[]>([]);

  React.useEffect(() => {
    if (!awareness) {
      setPointers([]);
      return undefined;
    }
    /** Re-read every peer's pointer, keeping the list when none moved. */
    const read = (): void => {
      const next = collectPointers(awareness.getStates(), awareness.clientID);
      setPointers((prev) => (samePointers(prev, next) ? prev : next));
    };
    read();
    awareness.on('change', read);
    return (): void => awareness.off('change', read);
  }, [awareness]);

  return <CanvasCursors pointers={pointers} zoom={zoom} />;
}
