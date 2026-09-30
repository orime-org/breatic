// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { referenceKinds, type ReferenceKind, type ReferencePool } from '@breatic/shared';
import * as React from 'react';

import { NO_REFERENCE_KINDS } from '@web/spaces/canvas/generate/reference-urls';

/**
 * The kinds a pool takes, as a list that keeps its identity until the kinds
 * change.
 *
 * The view model rebuilds the pool on every canvas change, and the rail and
 * the prompt editor it is handed to are memoised: a fresh list each render
 * would redraw both for nothing.
 * @param pool - The active model's pool in this mode.
 * @returns The kinds, stable across renders that do not change them.
 */
export function useReferenceKinds(pool: ReferencePool): readonly ReferenceKind[] {
  const key = referenceKinds(pool).join(',');
  return React.useMemo(
    () => (key === '' ? NO_REFERENCE_KINDS : (key.split(',') as ReferenceKind[])),
    [key],
  );
}
