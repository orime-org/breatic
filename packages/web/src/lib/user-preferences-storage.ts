// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';

import { STORAGE_KEYS } from '@web/lib/storage-keys';

/**
 * Interface preferences that belong to an account rather than to a project:
 * the Agent column width, the Studio rail sections, the canvas minimap and
 * snap. Two people share a browser often enough to matter, so the record is
 * keyed by account id and each account reads only its own entry.
 *
 * This module is the only place the key is read or written. Every field is
 * validated on its own: a value that does not parse costs that field its
 * stored value and nothing else. A broken account entry leaves every other
 * account's alone. A key that is not JSON reads as empty for everybody, and
 * the next write replaces it with that account's entry alone.
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

/** The whole key: account id to whatever was stored under it. */
type Record_ = Record<string, unknown>;

/**
 * Read the whole key, with anything unreadable reported as an empty record.
 * @returns The parsed record; nothing inside it is validated here.
 */
function readRecord(): Record_ {
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.userPreferences);
    if (value === null) return {};
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record_;
  } catch {
    // Private mode and blocked site data throw on access; a value that is not
    // JSON throws on parse. Both read as nothing stored.
    return {};
  }
}

/**
 * One account's stored entry, or an empty one when it is absent or is not an
 * object.
 * @param record - The whole record.
 * @param userId - The signed-in account.
 * @returns That account's raw entry.
 */
function entryFor(record: Record_, userId: string): Record_ {
  const entry: unknown = record[userId];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {};
  return entry as Record_;
}

/**
 * This account's preferences, every missing or unusable field at its default.
 * @param userId - The signed-in account; without one the defaults are returned.
 * @returns The account's preferences.
 */
export function readUserPreferences(userId: string | undefined): UserPreferences {
  if (userId === undefined || userId === '') return DEFAULT_USER_PREFERENCES;
  return preferencesSchema.parse(entryFor(readRecord(), userId));
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
  if (userId === undefined || userId === '') return;
  const record = readRecord();
  const next = { ...record, [userId]: { ...entryFor(record, userId), ...patch } };
  try {
    window.localStorage.setItem(STORAGE_KEYS.userPreferences, JSON.stringify(next));
  } catch {
    // Quota and blocked site data both throw; the value is still held in
    // memory for this session, it just is not remembered.
  }
}
