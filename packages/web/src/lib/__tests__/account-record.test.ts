// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openAccountRecord } from '@web/lib/account-record';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

describe('account record write acknowledgement', () => {
  beforeEach(() => window.localStorage.clear());

  it('returns success only after setItem succeeds and preserves another account', () => {
    window.localStorage.setItem(STORAGE_KEYS.sceneViews, JSON.stringify({ bob: { kept: true } }));
    expect(openAccountRecord(STORAGE_KEYS.sceneViews, 'alice')?.write({ value: 1 })).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.sceneViews)!)).toEqual({
      alice: { value: 1 }, bob: { kept: true },
    });
  });

  it('returns false when the browser refuses the write', () => {
    vi.stubGlobal('localStorage', {
      clear: vi.fn(),
      getItem: (): null => null,
      setItem: (): never => { throw new Error('blocked'); },
    });
    expect(openAccountRecord(STORAGE_KEYS.sceneViews, 'alice')?.write({ value: 1 })).toBe(false);
  });
});
