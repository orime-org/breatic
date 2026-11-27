// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Canonical JSON and its SHA-256 without a validator, for callers that cannot load one (the media container bundles
 * only this repository's code). `canonical-value.ts` validates its input and then serializes it here.
 */

/** A JSON value. */
export type CanonicalJson = string | number | boolean | null | CanonicalJson[] | { [key: string]: CanonicalJson };

/**
 * Serialize JSON with recursively ordered object keys.
 * @param value - Finite JSON.
 * @returns Canonical JSON text.
 * @throws {never} Never.
 */
export function serializeCanonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serializeCanonicalJson(value[key]!)}`).join(",")}}`;
}

/**
 * The lowercase SHA-256 of a value's canonical JSON.
 * @param value - Finite JSON.
 * @returns The digest.
 * @throws {DOMException} When the platform cannot compute SHA-256.
 */
export async function hashCanonicalJson(value: CanonicalJson): Promise<string> {
  const bytes = new TextEncoder().encode(serializeCanonicalJson(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
