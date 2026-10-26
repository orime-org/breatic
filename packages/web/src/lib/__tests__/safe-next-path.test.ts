// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { safeNextPath } from '@web/lib/safe-next-path';

describe('safeNextPath', () => {
  it.each([null, '', 'relative', 'https://outside.example/path', '//outside.example/path'])('uses the Studio destination for %s', (next) => {
    expect(safeNextPath(next)).toBe('/studio');
  });

  it.each(['/decision?token=invite', '/studio/acme#members', '/'])('keeps the internal destination %s', (next) => {
    expect(safeNextPath(next)).toBe(next);
  });

  it('preserves invitation tokens on internal decision destinations', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9]{1,64}$/), (token) => {
      const next = `/decision?token=${token}`;
      expect(safeNextPath(next)).toBe(next);
    }));
  });

  it('rejects protocol-relative destinations for every generated host', () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,24}$/), (host) => {
      expect(safeNextPath(`//${host}.example/decision`)).toBe('/studio');
    }));
  });
});
