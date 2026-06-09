// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Debounce a rapidly-changing value: returns the latest value only after it has
 * stopped changing for `delayMs`. Used to throttle live slug-availability
 * checks while the user is still typing, so a key-per-character does not fire a
 * request per keystroke.
 * @param value the value to debounce.
 * @param delayMs the quiet period (ms) the value must hold before it commits.
 * @returns the debounced value.
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
