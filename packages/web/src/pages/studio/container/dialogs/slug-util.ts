// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Slug validation for the create dialogs (spec §3.12 / URL design §5.7).
 * Studio slugs are globally unique (length 6–39) and checked against reserved
 * words; project / collection slugs are NOT unique (uuid disambiguates) and
 * only need to be well-formed (length 6–50).
 */

/** The shared slug character rule: lowercase start, letters / digits / single hyphens. */
const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Slug length bounds (URL design §5.7). */
export const STUDIO_SLUG_BOUNDS = { min: 6, max: 39 } as const;
export const ITEM_SLUG_BOUNDS = { min: 6, max: 50 } as const;

/** A small stub reserved-slug set (the real list is marketing's RESERVED-SLUGS v2). */
export const RESERVED_STUDIO_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'www',
  'studio',
  'project',
  'collection',
  'breatic',
  'orime',
  'login',
  'settings',
]);

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
  if (!SLUG_RE.test(value)) {
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
