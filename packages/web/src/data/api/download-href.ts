// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where a stored asset is downloaded from, as an address to navigate to.
 *
 * A string rather than a call: for the file to land in the browser's own
 * download list — with its progress, its pause, its retry — the browser has
 * to make the request itself. Anything we fetch and hand over arrives there
 * as an entry that was already complete.
 */

/** The query the resource domain answers with `Content-Disposition: attachment`. */
const DOWNLOAD_PARAM = 'download';

/**
 * The address that downloads one asset: its own public URL with
 * `download=1`. The resource domain answers that query with
 * `Content-Disposition: attachment`; a deployment reading files through an
 * `r2.dev` address has no such rule, and there the browser opens the file.
 * @param assetUrl - The asset's public URL, as a node holds it.
 * @returns The address to navigate to; an address that does not parse comes
 *   back as it was.
 */
export function downloadHref(assetUrl: string): string {
  if (!URL.canParse(assetUrl)) return assetUrl;
  const url = new URL(assetUrl);
  url.searchParams.set(DOWNLOAD_PARAM, '1');
  return url.toString();
}
