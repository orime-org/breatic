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
