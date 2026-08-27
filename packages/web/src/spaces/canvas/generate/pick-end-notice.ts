// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The message for a pick session the host node's own change put an end to.
 *
 * Split by who made that write and by nothing else: what the person needs to
 * know is that the session is over, and — when it was not their own doing —
 * that somebody else ended it. Which setting moved is the explanation, which
 * the copy rule leaves out.
 *
 * `FOCUS_EXIT_TOAST_KEY` in `CanvasSpace` says the same kind of thing about
 * the target side of a pick, and splits by the same author. It carries a
 * second level the target side needs: which verdict ended it.
 */
const PICK_END_TOAST_KEY: Record<'local' | 'peer', string> = {
  local: 'canvas.generatePanel.pickEnded',
  peer: 'canvas.generatePanel.pickEndedByPeer',
};

/**
 * Which message to show when a host-side change ends a pick session.
 * @param lastWriteWasLocal - Whether this client made that write.
 * @returns The translation key for the toast.
 */
export function pickEndToastKey(lastWriteWasLocal: boolean): string {
  return PICK_END_TOAST_KEY[lastWriteWasLocal ? 'local' : 'peer'];
}
