// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { toast } from 'sonner';

/**
 * Single stable id for every node-gate warning (locked / handling). sonner
 * de-duplicates by id: re-triggering with the same id UPDATES the existing toast
 * and resets its timer instead of stacking a new one. So rapid repeated blocks
 * — e.g. double-clicking a locked node's Execute — surface as ONE refreshing
 * toast, not a pile (user 2026-07-18). A node is only ever in one gate state at
 * a time, so a shared id across reasons is correct.
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
