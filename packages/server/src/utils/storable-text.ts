// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { z } from "zod";

/** With the u flag a well-formed pair is one code point, so only a surrogate with no partner matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Whether the database can store a string. Postgres text and jsonb refuse
 * NUL, and jsonb refuses a lone surrogate.
 * @param s - The string.
 * @returns True when neither is in it.
 */
export function isStorableText(s: string): boolean {
  return !s.includes("\u0000") && !LONE_SURROGATE.test(s);
}

/**
 * Whether every string in a parsed JSON value, keys included, can be stored.
 * @param value - The value.
 * @returns True when every string in it is storable.
 */
export function holdsOnlyStorableText(value: unknown): boolean {
  if (typeof value === "string") return isStorableText(value);
  if (Array.isArray(value)) return value.every(holdsOnlyStorableText);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, field]) => isStorableText(key) && holdsOnlyStorableText(field));
  }
  return true;
}

/**
 * A string field the database can store; a value carrying what it cannot is
 * refused here as a malformed body instead of failing the write.
 * @param schema - The field's own string rules.
 * @returns The schema with unstorable text refused.
 */
export function storableText(schema: z.ZodType<string>): z.ZodType<string> {
  return schema.refine(isStorableText);
}
