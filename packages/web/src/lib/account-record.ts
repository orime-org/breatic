// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A localStorage key holding one entry per account: `{ [userId]: entry }`.
 *
 * Two people share a browser often enough to matter, so what one account
 * stores is kept apart from the next one's. Anything the browser hands back
 * that does not parse reads as absent: a key that is not JSON is absent for
 * everybody, and an account entry that is not an object is absent for that
 * account only. Every access is wrapped, because private mode, a full quota
 * and blocked site data all throw, and these records are read during render.
 */

/** One account's entry, as stored; the caller validates what is inside. */
export type AccountEntry = Record<string, unknown>;

/** One account's view of a key, read once. */
export interface AccountRecord {
  /** That account's entry, or null when it is absent or not an object. */
  entry: AccountEntry | null;
  /**
   * Replace that account's entry, keeping every other account's entry as it
   * was when the key was read. Reports false when the browser refuses.
   * @param next - The complete replacement entry for the account selected when this record was opened.
   * @returns True when localStorage accepts the serialized record, or false when serialization or storage fails.
   */
  write: (next: AccountEntry) => boolean;
}

/**
 * Whether a value is a plain object, the only shape these records hold.
 * @param value - The decoded storage entry whose non-null, non-array object shape is being checked.
 * @returns True for a non-null, non-array object.
 */
function isObject(value: unknown): value is AccountEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a key once and pick out one account's entry.
 * @param key - The localStorage key containing the map of account identifiers to entries.
 * @param userId - The signed-in account whose entry is selected; an absent or empty identifier disables access.
 * @returns The selected account's entry and replacement writer, or null when no account is selected.
 */
export function openAccountRecord(
  key: string,
  userId: string | undefined,
): AccountRecord | null {
  if (userId === undefined || userId === '') return null;
  let record: AccountEntry = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    if (isObject(parsed)) record = parsed;
  } catch {
    // Unreadable storage and a value that is not JSON both read as empty.
  }
  const entry = record[userId];
  return {
    entry: isObject(entry) ? entry : null,
    write: (next) => {
      try {
        window.localStorage.setItem(key, JSON.stringify({ ...record, [userId]: next }));
        return true;
      } catch {
        // Quota and blocked site data both throw; the value is still held in
        // memory for this session, it just is not remembered.
        return false;
      }
    },
  };
}
