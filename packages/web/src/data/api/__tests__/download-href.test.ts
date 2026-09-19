// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The address a node's Download menu item points at.
 *
 * Same-origin and nothing else: the server reads the asset URL off it,
 * checks the URL is ours, and redirects to the Worker that serves the bytes
 * with `Content-Disposition`. Which is why this is a string and not a call —
 * the browser has to make the request itself for the download to land in its
 * own download list.
 */

import { describe, it, expect } from 'vitest';
import { downloadHref } from '@web/data/api/download-href';

describe('the download address for an asset', () => {
  it('points at our own API', () => {
    expect(downloadHref('https://assets.example.com/image/a.png')).toBe(
      '/api/v1/assets/download?url=https%3A%2F%2Fassets.example.com%2Fimage%2Fa.png',
    );
  });

  it('escapes the asset URL so its own query cannot leak into ours', () => {
    const href = downloadHref('https://assets.example.com/a.png?v=2&x=1');

    expect(href).toBe(
      `/api/v1/assets/download?url=${encodeURIComponent('https://assets.example.com/a.png?v=2&x=1')}`,
    );
    // One parameter, whatever the asset URL held.
    expect(href.split('?')).toHaveLength(2);
  });

  it('escapes a non-ASCII name', () => {
    const asset = 'https://assets.example.com/image/封面.png';

    expect(downloadHref(asset)).toBe(
      `/api/v1/assets/download?url=${encodeURIComponent(asset)}`,
    );
  });
});
