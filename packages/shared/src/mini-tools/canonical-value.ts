// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { hashCanonicalJson, serializeCanonicalJson } from "@shared/mini-tools/canonical-json.js";

const jsonSchema = z.json();

/**
 * Serializes a mini-tool contract value without depending on insertion order.
 * @param value - Contract data to validate.
 * @returns Canonical JSON text.
 * @throws {z.ZodError} When the value is not finite JSON.
 */
export function canonicalMiniToolValue(value: unknown): string {
  return serializeCanonicalJson(jsonSchema.parse(value));
}

/**
 * Hashes a versioned mini-tool value identically in the browser and backend.
 * @param value - Contract data to validate and hash.
 * @returns A lowercase SHA-256 digest.
 * @throws {z.ZodError} When the value is not finite JSON.
 * @throws {DOMException} When the platform cannot compute SHA-256.
 */
export async function hashMiniToolValue(value: unknown): Promise<string> {
  return hashCanonicalJson(jsonSchema.parse(value));
}
