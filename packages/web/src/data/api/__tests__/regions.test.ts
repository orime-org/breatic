// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The region table the web build carries (inner#1955): which address serves
 * each region's API and collab, which region a new Studio defaults to from the
 * user's time zone, and that a build with one region behaves exactly as today.
 */

import { describe, expect, it } from 'vitest';

import {
  apiBaseFor,
  collabUrlFor,
  defaultRegionForTimeZone,
  parseRegionConfig,
  regionToSend,
} from '@web/data/api/regions';

const TWO_REGIONS = parseRegionConfig(
  JSON.stringify({
    global: 'us-west',
    regions: {
      'us-west': { api: 'https://us.example.test/api/v1', collab: 'wss://us.example.test/collab' },
      sg: { api: 'https://sg.example.test/api/v1', collab: 'wss://sg.example.test/collab' },
    },
  }),
);

describe('parseRegionConfig', () => {
  it('reads an empty setting as no region table', () => {
    expect(parseRegionConfig(undefined)).toBeNull();
    expect(parseRegionConfig('')).toBeNull();
  });

  it('refuses a table whose global region has no address', () => {
    expect(() =>
      parseRegionConfig(JSON.stringify({ global: 'us-west', regions: { sg: { api: 'a', collab: 'b' } } })),
    ).toThrow();
  });
});

describe('apiBaseFor and collabUrlFor', () => {
  it('keep today\'s addresses when the build has no region table', () => {
    expect(apiBaseFor(null, null)).toBe('/api/v1');
    expect(apiBaseFor('sg', null)).toBe('/api/v1');
  });

  it('send a Studio with no region to the global region', () => {
    expect(apiBaseFor(null, TWO_REGIONS)).toBe('https://us.example.test/api/v1');
    expect(collabUrlFor(null, TWO_REGIONS)).toBe('wss://us.example.test/collab');
  });

  it('send a Studio in another region to that region', () => {
    expect(apiBaseFor('sg', TWO_REGIONS)).toBe('https://sg.example.test/api/v1');
    expect(collabUrlFor('sg', TWO_REGIONS)).toBe('wss://sg.example.test/collab');
  });

  it('refuse a region the build has no address for', () => {
    expect(() => apiBaseFor('eu', TWO_REGIONS)).toThrow();
  });
});

describe('defaultRegionForTimeZone', () => {
  it.each([
    ['Asia/Singapore', 'sg'],
    ['Asia/Shanghai', 'sg'],
    ['Australia/Sydney', 'sg'],
    ['Pacific/Auckland', 'sg'],
    ['Pacific/Honolulu', 'us-west'],
    ['Pacific/Guam', 'us-west'],
    ['America/Los_Angeles', 'us-west'],
    ['America/New_York', 'us-west'],
    ['Europe/London', 'us-west'],
  ])('picks the region for %s', (timeZone, region) => {
    expect(defaultRegionForTimeZone(timeZone, TWO_REGIONS)).toBe(region);
  });

  it('picks only a region the build has', () => {
    const globalOnly = parseRegionConfig(
      JSON.stringify({ global: 'us-west', regions: { 'us-west': { api: 'a', collab: 'b' } } }),
    );
    expect(defaultRegionForTimeZone('Asia/Singapore', globalOnly)).toBe('us-west');
  });
});

describe('regionToSend', () => {
  it('sends no region when the build has one region or none', () => {
    const globalOnly = parseRegionConfig(
      JSON.stringify({ global: 'us-west', regions: { 'us-west': { api: 'a', collab: 'b' } } }),
    );
    expect(regionToSend('us-west', globalOnly)).toBeUndefined();
    expect(regionToSend('sg', null)).toBeUndefined();
  });

  it('sends the chosen region when the build has several', () => {
    expect(regionToSend('sg', TWO_REGIONS)).toBe('sg');
  });
});
