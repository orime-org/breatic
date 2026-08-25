// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What ended a pick session from the host node's side.
 *
 * Both are writes to the host that the panel reacts to, and both can come from
 * a collaborator: `setNodeMode` and `setNodeModel` are ordinary document
 * writes. The video panel's vanishing slot is a mode change too — the slot
 * list is derived from the mode — so it reports the same reason.
 */
export type PickEndReason = 'modeChanged' | 'modelChanged';

/**
 * The message for each reason, split by who made the write.
 *
 * Same shape as `FOCUS_EXIT_TOAST_KEY` in `CanvasSpace`, which says the same
 * kind of thing about the target side of a pick: a local change is the user's
 * own doing coming back to them, a peer's is news.
 */
const PICK_END_TOAST_KEY: Record<
  'local' | 'peer',
  Record<PickEndReason, string>
> = {
  local: {
    modeChanged: 'canvas.generatePanel.pickEndedModeChanged',
    modelChanged: 'canvas.generatePanel.pickEndedModelChanged',
  },
  peer: {
    modeChanged: 'canvas.generatePanel.pickEndedModeChangedByPeer',
    modelChanged: 'canvas.generatePanel.pickEndedModelChangedByPeer',
  },
};

/**
 * Which message to show when a host-side change ends a pick session.
 * @param reason - What changed on the host.
 * @param lastWriteWasLocal - Whether this client made that write.
 * @returns The translation key for the toast.
 */
export function pickEndToastKey(
  reason: PickEndReason,
  lastWriteWasLocal: boolean,
): string {
  return PICK_END_TOAST_KEY[lastWriteWasLocal ? 'local' : 'peer'][reason];
}
