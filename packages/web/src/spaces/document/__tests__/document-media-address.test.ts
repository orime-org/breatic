// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether a pasted medium's address lands in the body (inner#1351 +
 * inner#1390 design §5.3, §5.4).
 */

import { describe, it, expect } from 'vitest';

import { addressLands } from '@web/spaces/document/document-media-address';

describe('addressLands', () => {
  it.each([
    ['an address of ours over http', 'http://cdn.local/a.png', 'http://cdn.local/', false, true],
    ['an address of ours while uploads cannot start', 'https://cdn.example/a.png', 'https://cdn.example/', false, true],
    ['an outside https address', 'https://e.example/a.png', 'https://cdn.example/', true, true],
    ['an outside https address while uploads cannot start', 'https://e.example/a.png', 'https://cdn.example/', false, false],
    ['an outside http address', 'http://e.example/a.png', 'https://cdn.example/', true, false],
    ['no address', '', 'https://cdn.example/', true, false],
    ['an outside https address while our prefix is not known', 'https://e.example/a.png', null, true, true],
  ] as const)('%s', (_what, url, prefix, canUpload, lands) => {
    expect(addressLands(url, prefix, canUpload)).toBe(lands);
  });
});
