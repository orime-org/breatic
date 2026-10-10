// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The address a node's Download menu item points at.
 *
 * The asset's own public URL with `download=1`: the resource domain answers
 * that query with `Content-Disposition: attachment`, which is what lands the
 * file in the browser's own download list.
 */

import { describe, it, expect } from 'vitest';
import { downloadHref } from '@web/data/api/download-href';

describe('the download address for an asset', () => {
  it('is the asset URL with download=1', () => {
    expect(downloadHref('https://assets.example.com/image/a.png')).toBe(
      'https://assets.example.com/image/a.png?download=1',
    );
  });

  it('keeps a query the asset URL already has', () => {
    const href = new URL(downloadHref('https://assets.example.com/a.png?v=2&x=1'));

    expect(href.origin + href.pathname).toBe('https://assets.example.com/a.png');
    expect(href.searchParams.get('v')).toBe('2');
    expect(href.searchParams.get('x')).toBe('1');
    expect(href.searchParams.get('download')).toBe('1');
  });

  it('sets download=1 once when the asset URL already names it', () => {
    const href = new URL(downloadHref('https://assets.example.com/a.png?download=0'));

    expect(href.searchParams.getAll('download')).toEqual(['1']);
  });

  it('keeps a non-ASCII name pointing at the same object', () => {
    const asset = 'https://assets.example.com/image/封面.png';
    const href = new URL(downloadHref(asset));

    expect(decodeURIComponent(href.pathname)).toBe('/image/封面.png');
    expect(href.searchParams.get('download')).toBe('1');
  });

  it('hands back an address that does not parse as it was', () => {
    expect(downloadHref('not a url')).toBe('not a url');
  });
});
