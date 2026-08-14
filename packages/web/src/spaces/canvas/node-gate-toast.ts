// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { toast } from '@web/lib/toast';

/**
 * Single stable id for every node-gate warning (locked / handling). sonner
 * de-duplicates by id: re-triggering with the same id UPDATES the existing toast
 * and resets its timer instead of stacking a new one. So rapid repeated blocks
 * — e.g. double-clicking a locked node's Execute — surface as ONE refreshing
 * toast, not a pile (user 2026-07-18).
 *
 * Sharing one id across reasons was originally justified by "a node is only
 * ever in one gate state at a time". That reason no longer covers everything
 * this carries: since #88 the same toast also delivers the CONNECTION notice,
 * which belongs to no node at all. The id still holds, on a wider reason — at
 * any moment there is exactly one thing standing between this person and the
 * write they attempted, so one refreshing toast is what should be on screen.
 * A connection that has gone read-only outranks any node state anyway: it
 * refuses the write before the node gate is even consulted.
 */
const NODE_GATE_TOAST_ID = 'canvas-node-gate';

/**
 * Shows the node-gate warning toast, de-duplicated by a stable id so repeated
 * blocks refresh one toast rather than stacking.
 * @param message - The localized gate message (already resolved via `t`).
 */
export function warnNodeGate(message: string): void {
  toast.warning(message, { id: NODE_GATE_TOAST_ID });
}
