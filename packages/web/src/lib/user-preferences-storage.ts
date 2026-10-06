// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';

import { openAccountRecord } from '@web/lib/account-record';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

/**
 * Interface preferences that belong to an account rather than to a project:
 * the Agent column width, the Studio rail sections, the canvas minimap and
 * snap. Two people share a browser often enough to matter, so the record is
 * keyed by account id and each account reads only its own entry.
 *
 * This module is the only place the key is read or written, through
 * `openAccountRecord`. Every field is validated on its own: a value that does
 * not parse costs that field its stored value and nothing else.
 */

/** Which Studio rail sections are folded. */
export interface RailCollapsed {
  personal: boolean;
  mine: boolean;
  joined: boolean;
}

/** One rail section. */
export type RailSection = keyof RailCollapsed;

/** Everything stored for one account, with the defaults filled in. */
export interface UserPreferences {
  /** The width the user dragged the Agent column to, or null when never set. */
  agentColumnWidth: number | null;
  railCollapsed: RailCollapsed;
  minimapVisible: boolean;
  snapToGrid: boolean;
}

/** What an account that has stored nothing sees. */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  agentColumnWidth: null,
  railCollapsed: { personal: false, mine: false, joined: false },
  minimapVisible: true,
  snapToGrid: false,
};

// `.catch` also answers for a missing field, since `undefined` fails each
// inner schema, so one fallback covers both absent and unusable.
const preferencesSchema = z.object({
  agentColumnWidth: z.number().finite().positive().nullable().catch(null),
  railCollapsed: z
    .object({
      personal: z.boolean().catch(false),
      mine: z.boolean().catch(false),
      joined: z.boolean().catch(false),
    })
    .catch(DEFAULT_USER_PREFERENCES.railCollapsed),
  minimapVisible: z.boolean().catch(true),
  snapToGrid: z.boolean().catch(false),
});

/**
 * This account's preferences, every missing or unusable field at its default.
 * @param userId - The signed-in account; without one the defaults are returned.
 * @returns The account's preferences.
 */
export function readUserPreferences(userId: string | undefined): UserPreferences {
  const account = openAccountRecord(STORAGE_KEYS.userPreferences, userId);
  return account === null ? DEFAULT_USER_PREFERENCES : preferencesSchema.parse(account.entry ?? {});
}

/**
 * Store some of this account's preferences, keeping the fields not named and
 * every other account's entry as they were.
 * @param userId - The signed-in account; nothing is written without one.
 * @param patch - The fields to store.
 */
export function writeUserPreference(
  userId: string | undefined,
  patch: Partial<UserPreferences>,
): void {
  const account = openAccountRecord(STORAGE_KEYS.userPreferences, userId);
  account?.write({ ...account.entry, ...patch });
}
