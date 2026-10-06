// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { STORAGE_KEYS } from '@web/lib/storage-keys';
import {
  DEFAULT_USER_PREFERENCES,
  readUserPreferences,
  writeUserPreference,
} from '@web/lib/user-preferences-storage';

const KEY = STORAGE_KEYS.userPreferences;
const ALICE = 'user-alice';
const BOB = 'user-bob';

/** What the browser is holding right now, parsed. */
function raw(): unknown {
  const value = window.localStorage.getItem(KEY);
  return value === null ? null : JSON.parse(value);
}

/** Put a record in place without going through the writer. */
function seed(value: unknown): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
}

describe('user preferences storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers with the defaults for an account that has stored nothing', () => {
    expect(readUserPreferences(ALICE)).toEqual({
      agentColumnWidth: null,
      railCollapsed: { personal: false, mine: false, joined: false },
      minimapVisible: true,
      snapToGrid: false,
    });
    expect(DEFAULT_USER_PREFERENCES).toEqual(readUserPreferences(ALICE));
  });

  it('keeps each account to its own values', () => {
    writeUserPreference(ALICE, { minimapVisible: false, agentColumnWidth: 500 });
    writeUserPreference(BOB, { snapToGrid: true });

    expect(readUserPreferences(ALICE)).toMatchObject({
      minimapVisible: false,
      agentColumnWidth: 500,
      snapToGrid: false,
    });
    expect(readUserPreferences(BOB)).toMatchObject({
      minimapVisible: true,
      agentColumnWidth: null,
      snapToGrid: true,
    });
  });

  it('merges a write into the fields already stored', () => {
    writeUserPreference(ALICE, { minimapVisible: false });
    writeUserPreference(ALICE, { railCollapsed: { personal: false, mine: true, joined: false } });

    expect(raw()).toEqual({
      [ALICE]: {
        minimapVisible: false,
        railCollapsed: { personal: false, mine: true, joined: false },
      },
    });
  });

  it('stores booleans and the width as plain JSON values', () => {
    writeUserPreference(ALICE, { snapToGrid: true, agentColumnWidth: 512 });
    expect(window.localStorage.getItem(KEY)).toBe(
      JSON.stringify({ [ALICE]: { snapToGrid: true, agentColumnWidth: 512 } }),
    );
  });

  it('falls back field by field when one stored value is unusable', () => {
    seed({
      [ALICE]: {
        minimapVisible: 'no',
        snapToGrid: true,
        agentColumnWidth: 'wide',
        railCollapsed: { personal: 1, mine: true, joined: false },
      },
    });

    expect(readUserPreferences(ALICE)).toEqual({
      agentColumnWidth: null,
      railCollapsed: { personal: false, mine: true, joined: false },
      minimapVisible: true,
      snapToGrid: true,
    });
  });

  it.each([0, -10, Number.MAX_VALUE * 10, null])(
    'reads a column width of %s as unset',
    (width) => {
      seed({ [ALICE]: { agentColumnWidth: width } });
      expect(readUserPreferences(ALICE).agentColumnWidth).toBeNull();
    },
  );

  it('leaves other accounts alone when one account entry is broken', () => {
    seed({ [ALICE]: 'broken', [BOB]: { snapToGrid: true } });

    expect(readUserPreferences(ALICE)).toEqual(DEFAULT_USER_PREFERENCES);
    expect(readUserPreferences(BOB).snapToGrid).toBe(true);

    writeUserPreference(ALICE, { minimapVisible: false });
    expect(raw()).toEqual({
      [ALICE]: { minimapVisible: false },
      [BOB]: { snapToGrid: true },
    });
  });

  it('treats a key that is not JSON as empty', () => {
    window.localStorage.setItem(KEY, '{not json');
    expect(readUserPreferences(ALICE)).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('reads defaults and writes nothing without an account', () => {
    writeUserPreference('', { snapToGrid: true });
    writeUserPreference(undefined, { snapToGrid: true });
    expect(raw()).toBeNull();
    expect(readUserPreferences(undefined)).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('keeps working when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(readUserPreferences(ALICE)).toEqual(DEFAULT_USER_PREFERENCES);
    expect(() => writeUserPreference(ALICE, { snapToGrid: true })).not.toThrow();
  });
});
