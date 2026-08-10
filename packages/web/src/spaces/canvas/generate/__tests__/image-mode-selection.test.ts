// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { resolveMode } from '@web/spaces/canvas/generate/image-mode-selection';

describe('resolveMode', () => {
  it('resolves the literal i2i to i2i', () => {
    expect(resolveMode('i2i')).toBe('i2i');
  });

  it('defaults undefined to t2i (a node with no stored mode)', () => {
    expect(resolveMode(undefined)).toBe('t2i');
  });

  it('sanitizes anything not exactly i2i to t2i (untrusted Yjs)', () => {
    // Only the literal 'i2i' is i2i; 't2i', '', and a malformed wire value all
    // resolve to the default so a corrupt string can never select a real mode
    // the picker cannot honor.
    expect(resolveMode('t2i')).toBe('t2i');
    expect(resolveMode('')).toBe('t2i');
    expect(resolveMode('bogus')).toBe('t2i');
  });
});
