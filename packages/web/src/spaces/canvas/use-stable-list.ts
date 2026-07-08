// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Keep a derived list's REFERENCE stable across renders while its content is
 * unchanged, so downstream `useMemo` / store subscribers that depend on it bail
 * instead of recomputing (#1647 step 4).
 *
 * The Yjs mirror rebuilds `flowNodes` on every doc change, so a derived
 * `flowNodes.filter(...).map(...)` yields a brand-new array each render even
 * when the result is identical (e.g. a position drag doesn't change the selected
 * ids). Passing that array through here collapses the identical results to the
 * previous reference. Content is compared element-wise with `Object.is` (or by
 * `keyOf` when items are objects); a length, order, or element change yields the
 * new reference.
 * @param list - The freshly derived list (new array reference each render).
 * @param keyOf - Optional key selector for object items (compared instead of the item).
 * @returns The previous array reference when content is unchanged, else `list`.
 */
export function useStableList<T>(
  list: ReadonlyArray<T>,
  keyOf?: (item: T) => unknown,
): T[] {
  const ref = React.useRef<T[]>(list as T[]);
  const prev = ref.current;
  let same = prev.length === list.length;
  if (same) {
    for (let i = 0; i < list.length; i += 1) {
      const a = keyOf ? keyOf(prev[i]) : prev[i];
      const b = keyOf ? keyOf(list[i]) : list[i];
      if (!Object.is(a, b)) {
        same = false;
        break;
      }
    }
  }
  if (!same) ref.current = list as T[];
  return ref.current;
}
