// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Which server the desktop client opens (inner#2041, design 6).
 *
 * Every build is dedicated to one server, ours or a brand's, written in at
 * build time; the client has no screen to enter or switch an address.
 * Accepted addresses follow the deployments `self-host/LOCAL.md` supports:
 * HTTPS by domain or IP, plain HTTP only on this machine, where `ENV=dev`
 * allows the session cookie without TLS. On a LAN address plain HTTP is not a
 * secure context and the production cookie is `Secure`, so it cannot work.
 */

/** Hosts that may be reached over plain HTTP: this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * An address as the origin the client opens.
 * @param input - The address.
 * @returns The origin, or null when the client refuses the address.
 */
export function normalizeServerUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url.origin;
  return null;
}

/**
 * The server a build carries; runs at build time, so a wrong brand.json fails the build.
 * @param raw - brand.json's serverUrl, or BREATIC_DEFAULT_SERVER_URL.
 * @returns The origin.
 * @throws {Error} When the address is empty, not https, or http to another computer.
 */
export function builtInServerUrl(raw: string): string {
  if (raw.trim() === "") throw new Error("serverUrl is required: every build carries the server it opens");
  const origin = normalizeServerUrl(raw);
  if (!origin) throw new Error(`serverUrl ${raw} must be an https address, or http to this computer`);
  return origin;
}

/**
 * The server to open: `BREATIC_SERVER_URL` in development, else the one the build carries.
 * @param sources - The override and the build's own.
 * @param sources.envUrl - `BREATIC_SERVER_URL` in development, else undefined.
 * @param sources.builtInUrl - The server written into the build, normalized by builtInServerUrl at build time.
 * @returns The origin.
 * @throws {Error} if the override is an address the client refuses.
 */
export function resolveServerUrl(sources: { envUrl: string | undefined; builtInUrl: string }): string {
  if (sources.envUrl) {
    const origin = normalizeServerUrl(sources.envUrl);
    if (!origin) throw new Error(`BREATIC_SERVER_URL is not an address the client accepts: ${sources.envUrl}`);
    return origin;
  }
  return sources.builtInUrl;
}
