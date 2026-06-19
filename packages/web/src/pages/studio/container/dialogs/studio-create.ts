// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type {
  StudioDetail,
  StudioSummary,
} from '@web/pages/studio/shared/studio-types';

/**
 * The studios the viewer may create projects in (spec §8.2 / §0.2): only an
 * `admin` or `maintainer` may create — a `guest` cannot (studio credits are
 * shared, so a plain guest must not be able to spend them by creating). Studios
 * the viewer is not a member of never reach here (`GET /studios` filters to
 * active memberships).
 * @param studios the viewer's studios, each with its current `myStudioRole`.
 * @returns the subset the viewer may create projects in, order preserved.
 */
export function creatableStudios(
  studios: readonly StudioSummary[],
): readonly StudioSummary[] {
  return studios.filter(
    (s) => s.myStudioRole === 'admin' || s.myStudioRole === 'maintainer',
  );
}

/**
 * The studio to pre-select in the create-project selector (spec §7.1): inside a
 * container where the viewer is the **admin** → that studio; otherwise (a
 * global/rail entry, or a studio the viewer is only a guest/maintainer of) → the
 * personal studio (the viewer is always its admin). The result is always one of
 * the `creatableStudios` options; `undefined` only when none exists (never in
 * practice — the personal studio always exists and the viewer is its admin).
 * @param studios the viewer's studios.
 * @param currentStudio the studio whose container the dialog opened in, if any.
 * @returns the default studio id, or `undefined` when nothing is creatable.
 */
export function defaultCreateStudioId(
  studios: readonly StudioSummary[],
  currentStudio?: StudioDetail,
): string | undefined {
  const creatable = creatableStudios(studios);
  if (
    currentStudio !== undefined &&
    currentStudio.myStudioRole === 'admin' &&
    creatable.some((s) => s.id === currentStudio.id)
  ) {
    return currentStudio.id;
  }
  const personal = creatable.find((s) => s.type === 'personal');
  return (personal ?? creatable[0])?.id;
}
