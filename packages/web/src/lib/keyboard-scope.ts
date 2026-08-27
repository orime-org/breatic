// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { isEditableTarget } from '@web/lib/is-editable-target';
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
 * Whether a keyboard or clipboard event belongs to `region`, asked in order:
 * an editable target handles its own keys; a target that sits in a region is
 * that region's; a target in no region at all is inside an overlay and handles
 * its own keys; and `<body>` — the one target with no region that is not an
 * overlay — means no element holds focus, so the active region decides.
 *
 * For a key press the middle two answers agree with the stored region anyway,
 * because focus entering a region writes it. They part company on a clipboard
 * event, whose target follows the SELECTION: a selection outlives the focus
 * move that left it behind, and it stays the property of the region it is in.
 * @param target - The event's target.
 * @param region - The region asking.
 * @returns True when the region should act on this event.
 */
export function regionOwnsKeyboard(
  target: EventTarget | null,
  region: ActiveRegion,
): boolean {
  if (!(target instanceof Element)) return false;
  if (isEditableTarget(target)) return false;

  const targetRegion = regionOf(target);
  if (targetRegion !== null) return targetRegion === region;
  if (target !== document.body) return false;

  return useUIStore.getState().activeRegion === region;
}
