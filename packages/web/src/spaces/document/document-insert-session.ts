// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one insert the plus has under way, shared between the two components
 * that each know half of it.
 *
 * The strip knows which block the menu is about to open in and whether it had
 * to make that block; the menu knows whether a command was chosen and when it
 * closed. Neither can answer A14 alone — the block only goes back out if
 * nothing was chosen — so the pair of facts lives here, in a ref the two share
 * through the tree they are both under.
 *
 * A ref rather than state: nothing renders differently because of it, and a
 * re-render between the plus and the menu would be a chance for the two to
 * disagree.
 */

import * as React from 'react';

/** What the plus started, while the menu it opened is still open. */
export interface InsertSession {
  /** The block the menu opened in. */
  readonly blockId: string;
  /** Whether the plus made that block, and so may take it back out. */
  readonly made: boolean;
}

/** The session in flight, or undefined when the menu was not opened by us. */
export type InsertSessionRef = React.MutableRefObject<
  InsertSession | undefined
>;

/**
 * Holds the insert the plus has under way.
 *
 * Defaults to a ref of its own so a component rendered outside the provider
 * reads an empty session rather than throwing — the menu can also be opened
 * by paths that never went through the plus.
 */
export const InsertSessionContext: React.Context<InsertSessionRef> =
  React.createContext<InsertSessionRef>({ current: undefined });

/**
 * The session the plus and the insert menu share.
 * @returns The ref holding it.
 */
export function useInsertSession(): InsertSessionRef {
  return React.useContext(InsertSessionContext);
}

/**
 * Ends the insert, and says what it was.
 *
 * Both of the two ways an insert ends — a command chosen, or the menu
 * dismissed — have to read it and clear it, and clear it whichever way the
 * read turns out. One function so that pair cannot come apart: a path that
 * read without clearing would let the NEXT dismissal withdraw a row this one
 * already finished with.
 * @param session - The ref the plus and the menu share.
 * @returns The insert that was under way, or undefined when none was.
 */
export function endInsert(
  session: InsertSessionRef,
): InsertSession | undefined {
  const pending = session.current;
  session.current = undefined;
  return pending;
}
