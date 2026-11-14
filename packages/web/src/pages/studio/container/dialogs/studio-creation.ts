// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What creating a Studio in a region shares between the new-Studio dialog and
 * onboarding (inner#1955): the browser names the Studio's id, keeps it while
 * the form is unchanged so a retry finishes the same creation, and takes a
 * new one when the form changes or the region gave the creation up.
 */

import { newId } from '@breatic/shared';
import * as React from 'react';

import { ApiException } from '@web/data/api/types';

/** Why a region refused a creation, when it is one the form answers itself. */
export type CreationRefusal = 'region_unavailable' | 'in_progress' | 'abandoned';

/**
 * The region refusal a failed create carries.
 * @param err - What the create threw.
 * @returns The refusal, or null for any other failure.
 */
export function creationRefusalOf(err: unknown): CreationRefusal | null {
  if (!(err instanceof ApiException)) return null;
  if (err.reason === 'region_unavailable') return 'region_unavailable';
  if (err.reason === 'studio_creation_in_progress') return 'in_progress';
  if (err.reason === 'studio_creation_abandoned') return 'abandoned';
  return null;
}

/**
 * The Studio id for the form as it stands: the same while the form is
 * unchanged, a new one once it changes or after `renew`.
 * @param form - Everything the user filled in, joined into one key.
 * @returns The id for this submission and a way to take a new one.
 */
export function useStudioCreationId(form: string): { idFor: () => string; renew: () => void } {
  const held = React.useRef<{ form: string; id: string } | null>(null);
  return React.useMemo(
    () => ({
      idFor: () => {
        if (held.current?.form !== form) held.current = { form, id: newId() };
        return held.current.id;
      },
      renew: () => {
        held.current = { form, id: newId() };
      },
    }),
    [form],
  );
}

/** Locale keys for the region names the build may carry. */
const REGION_NAME_KEYS: Record<string, string> = {
  'us-west': 'regions.usWest',
  sg: 'regions.sg',
};

/**
 * The locale key that names a region, or null for a code with no name.
 * @param region - The region code.
 * @returns The key.
 */
export function regionNameKey(region: string): string | null {
  return REGION_NAME_KEYS[region] ?? null;
}
