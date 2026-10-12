// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/** Which keys have a request out, and the way a press enters. */
export interface PendingKeys {
  /** Whether a request started for this key has not settled yet. */
  isPending: (key: string) => boolean;
  /** Hold the key until `work` settles, either way, and hand `work` back. */
  track: <T>(key: string, work: Promise<T>) => Promise<T>;
}

/**
 * Waiting state for a list of buttons, kept per key (inner#1374): a press on
 * row B does not end row A's wait, and A spins until A's own answer is in.
 * A key cannot be pressed again while it waits, because its button swallows
 * presses while `loading`.
 * @returns The keys waiting and the press entry point.
 */
export function usePendingKeys(): PendingKeys {
  const [keys, setKeys] = React.useState<ReadonlySet<string>>(() => new Set());

  const track = React.useCallback(<T,>(key: string, work: Promise<T>): Promise<T> => {
    setKeys((prev) => new Set(prev).add(key));
    /** Release the key once this press's work is over. */
    const settle = (): void => {
      setKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    };
    void work.then(settle, settle);
    return work;
  }, []);

  const isPending = React.useCallback((key: string): boolean => keys.has(key), [keys]);

  return React.useMemo(() => ({ isPending, track }), [isPending, track]);
}
