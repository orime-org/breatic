// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The clock behind a running task's two counters (#186 §7.3).
 *
 * Both numbers are derived from what the server decided — the instant the
 * task opened and the allowance it was given — so all the reader's clock does
 * is decide how current the counter looks. Nothing is judged from it.
 */

import * as React from 'react';

/** How often a running row's counters are recomputed. */
const TICK_MS = 1000;

/**
 * A clock that moves once a second while something is counting.
 *
 * The three settled states show fixed instants, so the timer stops whenever
 * no row is running rather than re-rendering the panel every second for
 * numbers that cannot change.
 * @param active - Whether any row on screen is counting.
 * @returns The current instant in epoch milliseconds.
 */
export function useTickingClock(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    // Catch up immediately: the clock may have been stopped for a while, and
    // a row that just started counting would otherwise open on a stale value.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return now;
}
