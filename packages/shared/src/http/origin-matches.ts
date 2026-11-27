// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Whether a request origin is admitted by an allow-list (inner#2157).
 *
 * An entry is an exact origin, or `<scheme>://*.<domain>[:port]`, which admits
 * exactly one label below `<domain>` on the same scheme and port. Only services
 * that carry no login state use wildcards (the ingest Worker); the session
 * services admit registered hosts one by one.
 * @param origin - The request's `Origin` header value.
 * @param entries - The allow-list entries, already trimmed.
 * @returns True when one entry admits the origin.
 */
export function originMatches(origin: string, entries: readonly string[]): boolean {
  for (const entry of entries) {
    if (entry === origin) return true;
    const star = entry.indexOf("://*.");
    if (star < 0) continue;
    const prefix = entry.slice(0, star + 3);
    const suffix = entry.slice(star + 4);
    if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) continue;
    const label = origin.slice(prefix.length, origin.length - suffix.length);
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return true;
  }
  return false;
}
