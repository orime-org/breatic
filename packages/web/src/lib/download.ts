// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Handing one stored asset to the browser to download.
 *
 * A link the page clicks for the reader, so the request is the browser's own
 * navigation and the file lands in its download list. The element is removed
 * straight after: a page that downloads several things would otherwise
 * accumulate one dead anchor per file.
 */

/** The query the resource domain answers with `Content-Disposition: attachment`. */
const DOWNLOAD_PARAM = 'download';

/**
 * Start a download of one asset: its own public URL with `download=1`.
 *
 * Whether the answer becomes a download or a navigation is decided by the
 * response: the resource domain answers that query with
 * `Content-Disposition: attachment`. A deployment reading files through an
 * `r2.dev` address has no such rule, and there the browser opens the file.
 * Nothing here waits to find out — once the browser has the address, this is
 * done.
 * @param assetUrl - The asset's public URL, as a node holds it.
 * @throws {TypeError} When `assetUrl` is not an absolute URL.
 */
export function downloadAsset(assetUrl: string): void {
  const url = new URL(assetUrl);
  url.searchParams.set(DOWNLOAD_PARAM, '1');
  const link = document.createElement('a');
  link.href = url.toString();
  // Aimed away from this document. A navigation of the current one runs its
  // `beforeunload` listeners before the request goes out — before anything
  // could know the answer is a file — so a page guarding unsaved work would
  // put "Leave site?" in front of a plain download, and Cancel would leave
  // the reader with nothing and no explanation. The context opened here holds
  // no document of its own and closes itself once the answer turns out to be
  // an attachment.
  link.target = '_blank';
  // No opener for the context this opens: it has nothing to say back to this
  // page, and the address it carries names one of our own objects.
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
