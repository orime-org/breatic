// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a key travels between the Worker and the media container on a host the
 * Worker intercepts: written into a URL by the Worker, read back from the
 * container's request. Shared by both, so the two halves are one copy.
 */

/**
 * The URL a container reaches one key at.
 *
 * A key carries whatever the upload's filename ended in, so each segment is
 * escaped whole: `#` and `?` left in the path would end it early, and the key
 * read back would be a prefix of the real one.
 * @param host - The intercepted hostname.
 * @param storageKey - The key.
 * @returns The URL.
 */
export function objectUrlOn(host: string, storageKey: string): string {
  const path = storageKey.split("/").map(encodeURIComponent).join("/");
  return `http://${host}/${path}`;
}

/**
 * The key a container's request names: the other half of {@link objectUrlOn}.
 * @param request - What the container sent.
 * @returns The key.
 */
export function askedKey(request: Request): string {
  return decodeURIComponent(new URL(request.url).pathname).slice(1);
}
