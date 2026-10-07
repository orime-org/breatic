// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Re-request `url` in CORS mode with a cache-busting param.
 *
 * The canvas loads a node's own image or video WITHOUT `crossOrigin`, and
 * serving that cached no-cors response to a CORS request is the classic
 * canvas-taint trap — the extra param guarantees a fresh CORS-mode fetch (the
 * bucket serves ACAO to a CORS GET). URL-API construction rather than string
 * append: appending lands the param AFTER a `#fragment`, where it never
 * reaches the wire.
 * @param url - The source URL.
 * @returns The URL to request.
 */
export function corsUrl(url: string): string {
  const busted = new URL(url, window.location.href);
  busted.searchParams.set('cors', '1');
  return busted.href;
}
