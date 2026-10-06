// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  RETIRED_STORAGE_KEYS,
  STORAGE_PREFIX,
  STORAGE_KEYS,
  removeRetiredStorageKeys,
} from '@web/lib/storage-keys';

describe('storage-keys registry', () => {
  const entries = Object.entries(STORAGE_KEYS);

  it('registers exactly the keys the app stores', () => {
    expect(STORAGE_KEYS).toEqual({
      locale: 'breatic.locale',
      theme: 'breatic.theme',
      projectTabs: 'breatic.projectTabs',
      userPreferences: 'breatic.userPreferences',
      sessionSeen: 'breatic.sessionSeen',
      deferredAppVersions: 'breatic.deferredAppVersions',
    });
  });

  it('pins STORAGE_PREFIX to "breatic."', () => {
    // The project-wide rule (breatic/storage-key-prefix): every persisted key
    // carries this prefix. Changing it is a breaking, cross-site decision.
    expect(STORAGE_PREFIX).toBe('breatic.');
  });

  it('every registered key carries the breatic. prefix', () => {
    for (const [name, key] of entries) {
      expect(
        key.startsWith(STORAGE_PREFIX),
        `${name}="${key}" must start with "${STORAGE_PREFIX}"`,
      ).toBe(true);
    }
  });

  it('has no duplicate key values (each key addresses a distinct slot)', () => {
    const values = entries.map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('removeRetiredStorageKeys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('names the five keys earlier versions wrote', () => {
    expect([...RETIRED_STORAGE_KEYS].sort()).toEqual([
      'breatic.agentColumnWidth',
      'breatic.joinedStudios',
      'breatic.myStudios',
      'breatic.personalStudios',
      'breatic.preferences',
    ]);
  });

  it('removes the retired keys and leaves every registered key', () => {
    for (const key of RETIRED_STORAGE_KEYS) window.localStorage.setItem(key, '1');
    for (const key of Object.values(STORAGE_KEYS)) window.localStorage.setItem(key, 'kept');

    removeRetiredStorageKeys();

    for (const key of RETIRED_STORAGE_KEYS) expect(window.localStorage.getItem(key)).toBeNull();
    for (const key of Object.values(STORAGE_KEYS)) {
      expect(window.localStorage.getItem(key)).toBe('kept');
    }
  });

  it('never retires a key that is still registered', () => {
    const live = new Set<string>(Object.values(STORAGE_KEYS));
    expect(RETIRED_STORAGE_KEYS.filter((key) => live.has(key))).toEqual([]);
  });

  it('stays quiet when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => removeRetiredStorageKeys()).not.toThrow();
  });
});
