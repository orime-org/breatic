// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { isEditableTarget } from '@web/lib/is-editable-target';
import { type ActiveRegion, useUIStore } from '@web/stores/ui';

/**
 * Whether a keyboard or clipboard event belongs to `region`, asked in order:
 * an editable target handles its own keys; a target whose ancestors pass
 * through no region at all is inside an overlay and handles its own keys;
 * otherwise the active region decides.
 *
 * `<body>` is the one target with no region that is not an overlay — it means
 * no element holds focus, which leaves the active region in charge.
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

  const inOverlay =
    target !== document.body && target.closest('[data-region]') === null;
  if (inOverlay) return false;

  return useUIStore.getState().activeRegion === region;
}
