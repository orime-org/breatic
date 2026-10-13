// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/** The controller returned by {@link useHeldName}. */
export interface HeldName<T extends string | null> {
  /** The name just committed while it is held, else `current`. */
  shown: string | T;
  /**
   * Shows `name` until `current` changes, or until `saving` rejects while
   * `name` is still the one held.
   */
  hold: (name: string, saving?: Promise<unknown> | void) => void;
}

/**
 * The name an inline rename box shows once it closes.
 *
 * The name reaches `current` some time after the box closes: a Yjs observe, a
 * query cache notification or a server's answer. Until then the label would
 * read the old name, so the committed one is held and drops as soon as
 * `current` moves, whichever value it moves to. A refused save drops it too,
 * which leaves `current` on screen; a refusal for a name since replaced by a
 * newer one leaves the newer one held.
 * @param current - The name as its source has it.
 * @returns The name to show and the call that holds a committed one.
 */
export function useHeldName<T extends string | null>(current: T): HeldName<T> {
  const [held, setHeld] = React.useState<string | null>(null);

  React.useEffect(() => {
    setHeld(null);
  }, [current]);

  /**
   * Holds a committed name.
   * @param name - The name the box committed.
   * @param saving - The save of that name, when the caller has one to watch.
   */
  const hold = React.useCallback((name: string, saving?: Promise<unknown> | void): void => {
    setHeld(name);
    if (saving === undefined) return;
    Promise.resolve(saving).catch(() => {
      setHeld((now) => (now === name ? null : now));
    });
  }, []);

  return { shown: held ?? current, hold };
}
