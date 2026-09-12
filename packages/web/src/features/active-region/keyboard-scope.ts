// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { type ActiveRegion, useUIStore } from '@web/stores/ui';

/**
 * Which of the two regions an element sits in, if either.
 *
 * The single place that reads the `data-region` attribute: the gate below and
 * the writers in `use-track-active-region` both ask this, so the selector and
 * the set of values it recognises exist once.
 * @param el - The element to place.
 * @returns The region it sits in, or null when no ancestor names one.
 */
export function regionOf(el: Element): ActiveRegion | null {
  const found = el.closest('[data-region]')?.getAttribute('data-region');
  return found === 'agent' || found === 'space' ? found : null;
}

/**
 * Whether a keyboard or clipboard event belongs to `region`.
 *
 * The active region is the single state this answers from. Focus is not a
 * rival source for it: moving focus into a region writes the region, exactly
 * as a pointer press does, so reading focus here would read one of the inputs
 * instead of the state it feeds — and they disagree whenever the region moved
 * without focus following, as pressing a scrollbar does.
 *
 * What the target does decide is whether an overlay is handling this press
 * itself. The overlays that do sit in no region because they portal to
 * `<body>` — Radix menus, popovers, dialogs. The panels xyflow's `NodeToolbar`
 * portals into `.react-flow__renderer` land inside the space region and are
 * the space's, which is what makes Delete from a generate panel delete its
 * host node. A target in either region, and `<body>` itself, defer to the
 * store.
 *
 * A field being typed in is a separate question, and the answer depends on
 * who else answers the key while a caret sits in one. Undo, paste, copy,
 * group, duplicate and delete are all answered by the field or by the browser
 * — Cmd+Z is the box's own undo, Cmd+G is find-again — so those six ask
 * `isEditableTarget` themselves. Escape has neither, so the two Escape
 * handlers take it from a field and rely on `defaultPrevented` for whoever
 * did consume it.
 * @param target - The event's target.
 * @param region - The region asking.
 * @returns True when the region should act on this event.
 */
export function regionOwnsKeyboard(
  target: EventTarget | null,
  region: ActiveRegion,
): boolean {
  if (!(target instanceof Element)) return false;
  if (regionOf(target) === null && target !== document.body) return false;

  return useUIStore.getState().activeRegion === region;
}
