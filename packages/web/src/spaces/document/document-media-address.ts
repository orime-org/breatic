// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a pasted medium's outside address reaches storage (inner#1351 +
 * inner#1390 design §5.3), for every way a medium comes into the body: a
 * canvas clipboard, web content and the uploads behind pending blocks.
 */

/** How an outside address reaches storage. */
export type AddressRoute = 'fetch' | 'file' | 'skip';

/**
 * The origin a `blob:` address belongs to, or null when it names none.
 * @param url - The address.
 * @returns The origin.
 */
function blobOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * How an outside address gets into storage (§5.3): an `https:` address is
 * fetched by the ingest Worker, a `data:` address or a `blob:` address of this
 * page's origin is read in the browser and uploaded as a file, anything else
 * is not pasted.
 * @param url - The address.
 * @returns The route.
 */
export function routeAddress(url: string): AddressRoute {
  if (url.startsWith('https://')) return 'fetch';
  if (url.startsWith('data:')) return 'file';
  // Only the origin that made a blob: address can read it (File API §8).
  if (url.startsWith('blob:')) return blobOrigin(url) === location.origin ? 'file' : 'skip';
  return 'skip';
}
