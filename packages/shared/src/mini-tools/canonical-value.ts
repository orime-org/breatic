// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

const jsonSchema = z.json();
type JsonValue = z.infer<typeof jsonSchema>;

/**
 * Serializes finite JSON with recursively ordered object keys.
 * @param value - Validated contract data.
 * @returns Canonical JSON text.
 */
function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serialize(value[key]!)}`).join(",")}}`;
}

/**
 * Serializes a mini-tool contract value without depending on insertion order.
 * @param value - Contract data to validate.
 * @returns Canonical JSON text.
 * @throws {z.ZodError} When the value is not finite JSON.
 */
export function canonicalMiniToolValue(value: unknown): string {
  return serialize(jsonSchema.parse(value));
}

/**
 * Hashes a versioned mini-tool value identically in the browser and backend.
 * @param value - Contract data to validate and hash.
 * @returns A lowercase SHA-256 digest.
 * @throws {z.ZodError} When the value is not finite JSON.
 * @throws {DOMException} When the platform cannot compute SHA-256.
 */
export async function hashMiniToolValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalMiniToolValue(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
