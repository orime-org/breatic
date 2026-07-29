// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { useQuery } from '@tanstack/react-query';

import { studiosApi } from '@web/data/api/studios';
import { useDebounce } from '@web/domain/use-debounce';
import {
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
  validateSlugShape,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';

/** The derived live-availability status of a slug input. */
export type SlugStatus =
  | 'idle'
  | 'invalid'
  | 'checking'
  | 'available'
  | 'taken';

/** The result of a live slug-availability check. */
export interface SlugAvailabilityResult {
  status: SlugStatus;
  /** The failure reason when `status` is `'invalid'` or `'taken'`. */
  reason?: SlugError;
}

/** Extra context for the check. */
export interface SlugAvailabilityOptions {
  /**
   * The slug the asking studio already holds, for the rename form.
   *
   * Without it the form is blocked by its own initial state: the server
   * truthfully answers "taken" about a slug taken by the very studio doing
   * the asking.
   */
  ownSlug?: string;
}

/**
 * Run the same shape + length + reserved checks the server enforces, so an
 * obviously-invalid slug never hits the network.
 * @param value the trimmed candidate slug.
 * @returns the first local failure reason, or `null` when locally acceptable.
 */
function validateLocally(value: string): SlugError {
  const shape = validateSlugShape(value, STUDIO_SLUG_BOUNDS);
  if (shape !== null) {
    return shape;
  }
  if (RESERVED_STUDIO_SLUGS.has(value)) {
    return 'reserved';
  }
  return null;
}

/**
 * Live (debounced) studio-slug availability — shared by the create-studio
 * dialog and the onboarding slug page so both behave identically.
 *
 * Local shape/length/reserved checks run first (no request for an
 * obviously-invalid slug); a well-formed slug is checked against the server.
 * **Race-safety**: React Query keys the query by the (debounced) slug, so an
 * out-of-order response for a slug the user has already edited away from is
 * stored under its own key and never overwrites the current input's status; the
 * `AbortSignal` cancels the superseded in-flight request. The server check is a
 * UX helper only — the authoritative uniqueness guard is the insert-time unique
 * index, so a slug shown `available` can still lose a race and 409 on submit.
 * @param rawSlug the current (un-debounced) slug input value.
 * @param options extra context — notably the caller's own slug, for renaming.
 * @returns the derived status + the failure reason when not available.
 */
export function useSlugAvailability(
  rawSlug: string,
  options?: SlugAvailabilityOptions,
): SlugAvailabilityResult {
  const trimmed = rawSlug.trim();
  const slug = useDebounce(trimmed, 300);
  const localError = validateLocally(slug);
  // The caller's own slug needs no server answer — it is theirs. The local
  // checks above still apply: this says "this one is yours", not "skip
  // validation", so a studio holding a since-reserved slug cannot re-submit it.
  const isOwn = options?.ownSlug !== undefined && slug === options.ownSlug;
  const enabled = slug.length > 0 && localError === null && !isOwn;

  const query = useQuery({
    queryKey: ['studio-slug-available', slug],
    queryFn: ({ signal }) => studiosApi.checkSlugAvailable(slug, signal),
    enabled,
    staleTime: 30_000,
  });

  if (trimmed.length === 0) {
    return { status: 'idle' };
  }
  // Debounce-skew guard: while the live input has not yet settled into the
  // debounced value, the query still reflects the OLD slug — report `checking`
  // so the submit gate never treats a stale `available` as valid for the new
  // input (the gate and the submitted slug stay consistent).
  if (trimmed !== slug) {
    return { status: 'checking' };
  }
  if (localError !== null) {
    return { status: 'invalid', reason: localError };
  }
  // Checked after the local rules so the exemption cannot smuggle through a
  // slug that is no longer valid at all.
  if (isOwn) {
    return { status: 'available' };
  }
  if (query.isFetching || query.data === undefined) {
    return { status: 'checking' };
  }
  if (query.data.available) {
    return { status: 'available' };
  }
  return { status: 'taken', reason: query.data.reason ?? 'taken' };
}
