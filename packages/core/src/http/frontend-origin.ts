// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { env } from "@core/config/env.js";
import { getInfluencersConfig } from "@core/config/influencers.js";
import { listHosts } from "@core/influencer/influencer.repo.js";

/**
 * The exact HTTP origins in `ALLOWED_ORIGINS`, in order.
 * @returns The origins that parse as themselves.
 */
function exactOrigins(): string[] {
  return env.ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  });
}

/**
 * Select a configured frontend origin for links sent outside the API.
 * Untrusted or absent request origins fall back to the first allowed origin.
 * @param requestOrigin - Origin supplied by the browser, if present.
 * @returns A trusted frontend origin, never the backend request host.
 * @throws {Error} If no valid HTTP frontend origin is configured.
 */
export function frontendOrigin(requestOrigin?: string): string {
  const origins = exactOrigins();
  const fallback = origins[0];
  if (!fallback) throw new Error("ALLOWED_ORIGINS must include a frontend HTTP origin");
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : fallback;
}

let hostCache: { hosts: Set<string>; readAt: number } | null = null;

/**
 * The registered influencer hosts, read again once the cache has aged out.
 * @returns The hosts, disabled ones included.
 * @throws {Error} When the database read fails.
 */
async function registeredHosts(): Promise<Set<string>> {
  const now = Date.now();
  const ttlMs = getInfluencersConfig().trusted_hosts_cache_seconds * 1000;
  if (hostCache && now - hostCache.readAt <= ttlMs) return hostCache.hosts;
  hostCache = { hosts: new Set(await listHosts()), readAt: now };
  return hostCache.hosts;
}

/**
 * Whether a browser origin may use the credentialed services (inner#2157):
 * an exact `ALLOWED_ORIGINS` item, or a registered influencer host on the
 * first item's scheme and port. Disabled influencers stay trusted.
 * @param origin - The request's `Origin` header value.
 * @returns True when trusted.
 * @throws {Error} When the influencer table cannot be read.
 */
export async function isTrustedFrontendOrigin(origin: string): Promise<boolean> {
  const origins = exactOrigins();
  if (origins.includes(origin)) return true;
  const first = origins[0];
  if (!first) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const base = new URL(first);
  if (url.protocol !== base.protocol || url.port !== base.port) return false;
  return (await registeredHosts()).has(url.hostname);
}

/**
 * The frontend an emailed link should point at for a request: its own origin
 * when trusted, so a user on an influencer site comes back to it.
 * @param requestOrigin - Origin supplied by the browser, if present.
 * @returns A trusted frontend origin.
 * @throws {Error} If no valid HTTP frontend origin is configured, or the influencer table cannot be read.
 */
export async function frontendOriginFor(requestOrigin?: string): Promise<string> {
  if (requestOrigin && (await isTrustedFrontendOrigin(requestOrigin))) return requestOrigin;
  return frontendOrigin();
}
