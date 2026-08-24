// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Slug validation for the create dialogs (spec §3.12 / URL design §5.7).
 * Studio slugs are globally unique (length 6–39) and checked against reserved
 * words; project / collection slugs are NOT unique (uuid disambiguates) and
 * only need to be well-formed (length 6–50).
 *
 * The studio rule itself — character shape, bounds, reserved words — is NOT
 * defined here. It lives on the shared schema the server validates every write
 * against, and is re-exported below so this module stays the frontend's single
 * import site. A second copy here would be a rule that silently drifts: the
 * form would accept what the API then refuses, or worse, promise a slug is
 * free when the server has reserved it.
 */

import {
  SLUG_REGEX,
  RESERVED_STUDIO_SLUGS,
  STUDIO_SLUG_BOUNDS,
} from '@breatic/shared';

export { RESERVED_STUDIO_SLUGS, STUDIO_SLUG_BOUNDS };

/** Item slugs are frontend-only (not unique, no reserved list) — bounds live here. */
export const ITEM_SLUG_BOUNDS = { min: 6, max: 50 } as const;

/** A slug validation failure reason, or `null` when the slug is acceptable. */
export type SlugError = 'format' | 'length' | 'reserved' | 'taken' | null;

interface SlugBounds {
  min: number;
  max: number;
}

/**
 * Validate slug character format + length (the rules shared by every slug).
 * Format is checked before length so a malformed slug reports the character
 * rule rather than a length error.
 * @param value the candidate slug.
 * @param bounds the min / max length bounds.
 * @returns `'format'`, `'length'`, or `null` when well-formed.
 */
export function validateSlugShape(
  value: string,
  bounds: SlugBounds,
): 'format' | 'length' | null {
  if (!SLUG_REGEX.test(value)) {
    return 'format';
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    return 'length';
  }
  return null;
}

/**
 * Validate a studio slug — shape, then reserved words, then uniqueness against
 * the already-taken slugs (studio slugs are globally unique, §5.7).
 * @param value the candidate studio slug.
 * @param takenSlugs the set of studio slugs already in use.
 * @returns the first failure reason, or `null` when acceptable.
 */
export function validateStudioSlug(
  value: string,
  takenSlugs: ReadonlySet<string>,
): SlugError {
  const shape = validateSlugShape(value, STUDIO_SLUG_BOUNDS);
  if (shape !== null) {
    return shape;
  }
  if (RESERVED_STUDIO_SLUGS.has(value)) {
    return 'reserved';
  }
  if (takenSlugs.has(value)) {
    return 'taken';
  }
  return null;
}

/**
 * Validate a project / collection slug — shape only (not unique; uuid
 * disambiguates, §5.7, so no reserved / taken checks).
 * @param value the candidate slug.
 * @returns the shape failure reason, or `null` when well-formed.
 */
export function validateItemSlug(value: string): SlugError {
  return validateSlugShape(value, ITEM_SLUG_BOUNDS);
}
