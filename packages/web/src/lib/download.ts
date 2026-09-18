// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Handing one address to the browser to download.
 *
 * A link the page clicks for the reader, so the request is the browser's own
 * navigation and the file lands in its download list. The element is removed
 * straight after: a page that downloads several things would otherwise
 * accumulate one dead anchor per file.
 */

/**
 * Start a download of `href`.
 *
 * Whether the answer becomes a download or a navigation is decided by the
 * response: it downloads when the server sends `Content-Disposition:
 * attachment`. Nothing here can force that, and nothing here waits to find
 * out — once the browser has the address, this is done.
 * @param href - The address to download.
 */
export function triggerDownload(href: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
