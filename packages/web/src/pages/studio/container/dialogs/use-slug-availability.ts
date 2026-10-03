// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';

import { studiosApi } from '@web/data/api/studios';
import { useDebounce } from '@web/lib/use-debounce';
import { ApiException } from '@web/data/api/types';
import {
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
  validateSlugShape,
  type SlugCheck,
  type SlugError,
} from '@web/pages/studio/container/dialogs/slug-util';

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
 * Cache key of one slug's availability answer.
 * @param slug - The trimmed slug.
 * @returns The query key.
 */
function slugAvailabilityKey(slug: string): readonly unknown[] {
  return ['studio-slug-available', slug];
}

/**
 * Live (debounced) studio-slug availability — shared by the create-studio
 * dialog, the rename-slug dialog and the onboarding slug page so all three
 * behave identically.
 *
 * Local shape/length/reserved checks run first (no request for an
 * obviously-invalid slug); a well-formed slug is checked against the server.
 * **Race-safety**: React Query keys the query by the (debounced) slug, so an
 * out-of-order response for a slug the user has already edited away from is
 * stored under its own key and never overwrites the current input's status; the
 * `AbortSignal` cancels the superseded in-flight request. The server check is a
 * UX helper only — the authoritative uniqueness guard is the insert-time unique
 * index, so a slug shown `valid` can still lose a race and 409 on submit.
 * @param rawSlug the current (un-debounced) slug input value.
 * @param options extra context — notably the caller's own slug, for renaming.
 * @returns where the slug stands, in the slug field's own terms.
 */
export function useSlugAvailability(
  rawSlug: string,
  options?: SlugAvailabilityOptions,
): SlugCheck {
  const trimmed = rawSlug.trim();
  const slug = useDebounce(trimmed, 300);
  const localError = validateLocally(slug);
  // The caller's own slug needs no server answer — it is theirs. The local
  // checks above still apply: this says "this one is yours", not "skip
  // validation", so a studio holding a since-reserved slug cannot re-submit it.
  const isOwn = options?.ownSlug !== undefined && slug === options.ownSlug;
  const enabled = slug.length > 0 && localError === null && !isOwn;

  const query = useQuery({
    queryKey: slugAvailabilityKey(slug),
    queryFn: ({ signal }) => studiosApi.checkSlugAvailable(slug, signal),
    enabled,
    staleTime: 30_000,
  });

  if (trimmed.length === 0) {
    return { state: 'empty' };
  }
  // Debounce-skew guard: while the live input has not yet settled into the
  // debounced value, the query still reflects the OLD slug — report `checking`
  // so the submit gate never treats a stale `valid` as valid for the new
  // input (the gate and the submitted slug stay consistent).
  if (trimmed !== slug) {
    return { state: 'checking' };
  }
  if (localError !== null) {
    return { state: 'invalid', reason: localError };
  }
  // Checked after the local rules so the exemption cannot smuggle through a
  // slug that is no longer valid at all.
  if (isOwn) {
    return { state: 'valid' };
  }
  if (query.isFetching || query.data === undefined) {
    return { state: 'checking' };
  }
  if (query.data.available) {
    return { state: 'valid' };
  }
  return { state: 'invalid', reason: query.data.reason ?? 'taken' };
}

/**
 * Decide whether a refused submit is already being shown by the slug field.
 *
 * A 409 does not always mean the slug: creating a team studio also answers 409
 * when the account is at its team-studio cap. Re-asking the server refreshes
 * the cached answer the field reads, so a taken slug turns the field red on
 * its own. That only tells the reader something while the field is on screen
 * and holds the submitted slug; the caller says whether it still does, after
 * the re-ask has come back.
 * @param client - The query client holding the availability answers.
 * @param err - What the submit threw.
 * @param slug - The trimmed slug that was submitted.
 * @param fieldShown - Whether the field holding `slug` is still on screen.
 * @returns Whether the field now shows the conflict, so the caller's own
 *   error exit has nothing to add.
 */
export async function slugFieldShowsConflict(
  client: QueryClient,
  err: unknown,
  slug: string,
  fieldShown: () => boolean,
): Promise<boolean> {
  if (!(err instanceof ApiException) || err.status !== 409) {
    return false;
  }
  const taken = await client
    .fetchQuery({
      queryKey: slugAvailabilityKey(slug),
      queryFn: ({ signal }) => studiosApi.checkSlugAvailable(slug, signal),
      staleTime: 0,
    })
    .then((answer) => !answer.available)
    .catch(() => false);
  return taken && fieldShown();
}

/**
 * Track which slug a dialog's slug field shows, for the 409 re-ask to read
 * once it has come back: by then the dialog may have closed, been reopened on
 * a reset field, or unmounted with its page.
 * @param open - Whether the dialog holding the field is open.
 * @param slug - The field's current value.
 * @returns A stable check: does the field show this trimmed slug right now?
 */
export function useSlugFieldShown(
  open: boolean,
  slug: string,
): (submitted: string) => boolean {
  const shownRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    shownRef.current = open ? slug.trim() : null;
    return () => {
      shownRef.current = null;
    };
  }, [open, slug]);
  return React.useCallback(
    (submitted: string): boolean => shownRef.current === submitted,
    [],
  );
}
