// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether an address may be fetched: every address its host resolves to is
 * public unicast. A name that does not resolve is let through, so the request
 * reports why it failed.
 * @param url - The address.
 * @returns False for a malformed url or any private, loopback, link-local or reserved address.
 */
export async function reachable(url: string): Promise<boolean> {
  void url;
  throw new Error("reachable is not implemented");
}
