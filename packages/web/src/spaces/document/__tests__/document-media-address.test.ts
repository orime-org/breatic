// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a pasted medium's address lands in the body (inner#1351 +
 * inner#1390 design §5.3, §5.4).
 */

import { describe, it, expect } from 'vitest';

import { addressLanding } from '@web/spaces/document/document-media-address';

describe('addressLanding', () => {
  it.each([
    ['an address of ours over http', 'http://cdn.local/a.png', 'http://cdn.local/', false, 'ours'],
    ['an address of ours while uploads cannot start', 'https://cdn.example/a.png', 'https://cdn.example/', false, 'ours'],
    ['an outside https address', 'https://e.example/a.png', 'https://cdn.example/', true, 'upload'],
    ['an outside https address while uploads cannot start', 'https://e.example/a.png', 'https://cdn.example/', false, null],
    ['an outside http address', 'http://e.example/a.png', 'https://cdn.example/', true, null],
    ['no address', '', 'https://cdn.example/', true, null],
    ['an outside https address while our prefix is not known', 'https://e.example/a.png', null, true, 'upload'],
  ] as const)('%s', (_what, url, prefix, canUpload, landing) => {
    expect(addressLanding(url, prefix, canUpload)).toBe(landing);
  });
});
