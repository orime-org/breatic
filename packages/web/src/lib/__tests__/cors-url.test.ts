// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { corsUrl } from '@web/lib/cors-url';

describe('corsUrl', () => {
  it('adds a cache-busting param, so the browser fetches afresh in CORS mode', () => {
    expect(new URL(corsUrl('https://resource.test/image/a.png')).searchParams.get('cors')).toBe('1');
  });

  it('keeps the param before a fragment, where it reaches the wire', () => {
    expect(corsUrl('https://resource.test/a.png?x=1#frag')).toBe('https://resource.test/a.png?x=1&cors=1#frag');
  });
});
