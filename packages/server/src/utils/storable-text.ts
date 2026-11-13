// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { z } from "zod";

/** With the u flag a well-formed pair is one code point, so only a surrogate with no partner matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/** Every lone surrogate in a string. */
const LONE_SURROGATES = /\p{Cs}/gu;

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
 * A string the store can hold: NUL removed and a lone surrogate replaced.
 * @param s - The string.
 * @returns The same string, storable.
 */
function storableString(s: string): string {
  return s.replaceAll("\u0000", "").replace(LONE_SURROGATES, "\uFFFD");
}

/**
 * A value as the store will hold it, every string in it, keys included,
 * storable. What a turn writes comes from models, pages and files as well as
 * the user, and one string the store refuses fails the whole row every time
 * it is written. Read through JSON, which is what the store writes, so a
 * value such as a URL or a date becomes what the store would have made of it.
 * @param value - The value.
 * @returns The same value, its strings storable.
 */
export function asStorable<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value), (_key, field: unknown) => {
    if (typeof field === "string") return storableString(field);
    if (field === null || typeof field !== "object" || Array.isArray(field)) return field;
    return Object.fromEntries(Object.entries(field).map(([k, v]) => [storableString(k), v]));
  }) as T;
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
