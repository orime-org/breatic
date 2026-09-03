// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/**
 * Keeps a value's identity while its CONTENT is unchanged.
 *
 * Every Generate panel's view model rebuilds on every canvas mutation — every
 * frame of any node drag — so the arrays and objects it returns are new each
 * time. Handed straight to a `React.memo` child, that defeats the memo, which
 * is the same as not having one.
 *
 * Keyed on a serialization of the value: the things this is used for are short
 * (a handful of reference rows, a slot object of a few URLs, one model's
 * params), so stringifying them each render is cheap and exact. It is exact
 * only for JSON-shaped data — the callers pass plain objects and arrays of
 * strings, numbers and nulls, which is what a view model is made of.
 *
 * One home for the pattern, so the `exhaustive-deps` suppression it needs
 * lives in one place rather than once per call site.
 * @param value - The freshly-built value.
 * @returns The same value while its serialization is unchanged.
 */
export function useContentStable<T>(value: T): T {
  const key = JSON.stringify(value);
  return React.useMemo(
    () => value,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content identity: the key IS the value, serialized
    [key],
  );
}
