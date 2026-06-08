// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { STORAGE_PREFIX, STORAGE_KEYS } from '@web/lib/storage-keys';

describe('storage-keys registry', () => {
  const entries = Object.entries(STORAGE_KEYS);

  it('exposes at least the four known keys', () => {
    expect(Object.keys(STORAGE_KEYS)).toEqual(
      expect.arrayContaining([
        'locale',
        'preferences',
        'railMyStudios',
        'railJoinedStudios',
      ]),
    );
  });

  it('pins STORAGE_PREFIX to "breatic."', () => {
    // The project-wide rule (lint:storage-key-prefix): every persisted key
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
