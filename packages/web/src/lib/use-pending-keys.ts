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
 * Two presses on one key are counted, so the first to settle does not end the
 * second.
 * @returns The keys waiting and the press entry point.
 */
export function usePendingKeys(): PendingKeys {
  const [counts, setCounts] = React.useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  const track = React.useCallback(<T,>(key: string, work: Promise<T>): Promise<T> => {
    setCounts((prev) => new Map(prev).set(key, (prev.get(key) ?? 0) + 1));
    /** Release one hold on the key once this press's work is over. */
    const settle = (): void => {
      setCounts((prev) => {
        const next = new Map(prev);
        const left = (prev.get(key) ?? 1) - 1;
        if (left > 0) next.set(key, left);
        else next.delete(key);
        return next;
      });
    };
    void work.then(settle, settle);
    return work;
  }, []);

  const isPending = React.useCallback(
    (key: string): boolean => counts.has(key),
    [counts],
  );

  return React.useMemo(() => ({ isPending, track }), [isPending, track]);
}
