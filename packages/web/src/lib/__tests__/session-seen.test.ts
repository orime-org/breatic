// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { hasSeenSession, rememberSession } from '@web/lib/session-seen';
import { STORAGE_KEYS } from '@web/lib/storage-keys';

describe('session-seen', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers no for a browser that has never held a session', () => {
    expect(hasSeenSession()).toBe(false);
  });

  it('remembers a session, and forgets it again', () => {
    rememberSession(true);
    expect(hasSeenSession()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.sessionSeen)).not.toBeNull();

    rememberSession(false);
    expect(hasSeenSession()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.sessionSeen)).toBeNull();
  });

  it('answers no when storage cannot be read', () => {
    // Design §6.2, the preload gate: unreadable storage is treated as `UNKNOWN`, which is the
    // side that costs a round trip rather than a download the reader is about
    // to be bounced away from.
    rememberSession(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });

    expect(hasSeenSession()).toBe(false);
  });

  it('survives a storage that cannot be written', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });

    expect(() => {
      rememberSession(true);
    }).not.toThrow();
  });
});
