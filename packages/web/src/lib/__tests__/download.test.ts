// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Handing one stored asset to the browser to download.
 *
 * The click is what makes the request the browser's own, and the removal is
 * what keeps a page that downloads several files from accumulating anchors.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { downloadAsset } from '@web/lib/download';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * What the anchor looked like at the moment it was clicked.
 *
 * Read there rather than afterwards: the element is removed as soon as the
 * click returns, so holding the reference and asking later reports the state
 * after removal for every field.
 */
function anchorAtClick(): {
  href: string | null;
  target: string | null;
  connected: boolean;
  } {
  const captured = {
    href: null as string | null,
    target: null as string | null,
    connected: false,
  };
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    captured.href = this.getAttribute('href');
    captured.target = this.getAttribute('target');
    captured.connected = this.isConnected;
  });
  return captured;
}

describe('starting a download', () => {
  it('clicks a link pointing at the asset URL with download=1', () => {
    const captured = anchorAtClick();

    downloadAsset('https://assets.example.com/image/a.png');

    expect(captured.href).toBe('https://assets.example.com/image/a.png?download=1');
  });

  it('keeps a query the asset URL already has', () => {
    const captured = anchorAtClick();

    downloadAsset('https://assets.example.com/a.png?v=2&x=1');

    const href = new URL(captured.href ?? '');
    expect(href.origin + href.pathname).toBe('https://assets.example.com/a.png');
    expect(href.searchParams.get('v')).toBe('2');
    expect(href.searchParams.get('x')).toBe('1');
    expect(href.searchParams.get('download')).toBe('1');
  });

  it('sets download=1 once when the asset URL already names it', () => {
    const captured = anchorAtClick();

    downloadAsset('https://assets.example.com/a.png?download=0');

    expect(new URL(captured.href ?? '').searchParams.getAll('download')).toEqual(['1']);
  });

  it('keeps a non-ASCII name pointing at the same object', () => {
    const captured = anchorAtClick();

    downloadAsset('https://assets.example.com/image/封面.png');

    const href = new URL(captured.href ?? '');
    expect(decodeURIComponent(href.pathname)).toBe('/image/封面.png');
    expect(href.searchParams.get('download')).toBe('1');
  });

  it('has the link in the document when it clicks', () => {
    const captured = anchorAtClick();

    downloadAsset('https://assets.example.com/a.png');

    expect(captured.connected).toBe(true);
  });

  // The page this was pressed on holds a beforeunload guard while an upload is
  // in flight, and a navigation of the current document runs it before the
  // request goes out — long before the answer could say it is a download. The
  // reader would get "Leave site?" on the happy path, and pressing Cancel
  // would leave them with no download and nothing said. Aiming elsewhere takes
  // this document out of it.
  it('aims the navigation away from the page it was pressed on', () => {
    const captured = anchorAtClick();

    downloadAsset('https://assets.example.com/a.png');

    expect(captured.target).toBe('_blank');
  });

  it('leaves no anchor behind', () => {
    anchorAtClick();
    const before = document.querySelectorAll('a').length;

    downloadAsset('https://assets.example.com/a.png');

    expect(document.querySelectorAll('a')).toHaveLength(before);
  });
});
