// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/** What {@link useRunAfterMenuClose} hands a menu. */
export interface RunAfterMenuClose {
  /**
   * An item handler that runs `action` once the menu has closed.
   * @param action - What the item does.
   * @returns The `onSelect` handler for the item.
   */
  later: (action: (() => void) | undefined) => (() => void) | undefined;
  /** The menu content's `onCloseAutoFocus`. */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * Runs a menu item's action after the menu has fully closed. A menu keeps the
 * keyboard through its exit animation and gives it back to its anchor when it
 * is gone, so an action that hands the keyboard to something (an inline
 * editor, a pasted copy) waits for that and stops the give-back.
 * @returns The item wrapper and the content's close handler.
 */
export function useRunAfterMenuClose(): RunAfterMenuClose {
  const pending = React.useRef<(() => void) | null>(null);
  const later = React.useCallback(
    (action: (() => void) | undefined): (() => void) | undefined =>
      action === undefined
        ? undefined
        : () => {
          pending.current = action;
        },
    [],
  );
  const onCloseAutoFocus = React.useCallback((event: Event): void => {
    const action = pending.current;
    if (action === null) return;
    pending.current = null;
    event.preventDefault();
    action();
  }, []);
  return { later, onCloseAutoFocus };
}
