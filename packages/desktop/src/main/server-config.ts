// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which server the desktop client opens (#1599, design 6).
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
 * @returns The origin, or why the address is refused.
 */
export function normalizeServerUrl(input: string): { ok: true; origin: string } | { ok: false; reason: "scheme" } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: "scheme" };
  }
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, origin: url.origin };
  return { ok: false, reason: "scheme" };
}

/**
 * The server a build carries; runs at build time, so a wrong brand.json fails the build.
 * @param raw - brand.json's serverUrl, or BREATIC_DEFAULT_SERVER_URL.
 * @returns The origin.
 * @throws {Error} When the address is empty, not https, or http to another computer.
 */
export function builtInServerUrl(raw: string): string {
  if (raw.trim() === "") throw new Error("serverUrl is required: every build carries the server it opens");
  const result = normalizeServerUrl(raw);
  if (!result.ok) throw new Error(`serverUrl ${raw} must be an https address, or http to this computer`);
  return result.origin;
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
    const normalized = normalizeServerUrl(sources.envUrl);
    if (!normalized.ok) throw new Error(`BREATIC_SERVER_URL is not an address the client accepts: ${sources.envUrl}`);
    return normalized.origin;
  }
  return sources.builtInUrl;
}
