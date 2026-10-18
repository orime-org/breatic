// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import { mergeTouch, touchFrom } from '@web/data/analytics/attribution';

const NOW = '2026-10-12T01:00:00.000Z';

describe('touchFrom', () => {
  it('records the campaign and the landing path', () => {
    const touch = touchFrom(new URL('https://app.example.com/register?utm_source=x&gclid=g&other=1'), '', NOW);
    expect(touch).toEqual({ utm_source: 'x', gclid: 'g', landing_page: '/register', at: NOW });
  });

  it('records an outside referrer without its query', () => {
    expect(touchFrom(new URL('https://app.example.com/'), 'https://news.example.org/a?b=c', NOW)).toEqual({
      referrer: 'https://news.example.org/a',
      landing_page: '/',
      at: NOW,
    });
  });

  it('ignores a page reached from inside the site with no campaign', () => {
    expect(touchFrom(new URL('https://app.example.com/studio'), 'https://app.example.com/', NOW)).toBeNull();
  });
});

describe('mergeTouch', () => {
  const first = { utm_source: 'a', landing_page: '/', at: NOW };

  it('keeps the first touch and moves the latest with a new campaign', () => {
    const next = { utm_source: 'b', landing_page: '/x', at: NOW };
    expect(mergeTouch({ first, last: first }, next)).toEqual({ first, last: next });
  });

  it('leaves both alone for a visit without a campaign', () => {
    const referred = { referrer: 'https://news.example.org/', landing_page: '/', at: NOW };
    expect(mergeTouch({ first, last: first }, referred)).toEqual({ first, last: first });
  });

  it('starts both from the first touch', () => {
    expect(mergeTouch(null, first)).toEqual({ first, last: first });
  });
});
