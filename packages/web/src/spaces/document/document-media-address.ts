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

/**
 * Whether a pasted medium at this address lands in the body: an address of
 * ours stays, and an outside one lands when it can reach storage and the
 * body can start uploads.
 * @param url - The medium's address.
 * @param prefix - What every address of ours starts with, or null while it
 *   is not known.
 * @param canUpload - Whether the body starts uploads.
 * @returns True when the medium lands.
 */
export function addressLands(url: string, prefix: string | null, canUpload: boolean): boolean {
  if (url === '') return false;
  if (prefix !== null && url.startsWith(prefix)) return true;
  return canUpload && routeAddress(url) !== 'skip';
}
