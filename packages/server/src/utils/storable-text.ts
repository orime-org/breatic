// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { z } from "zod";

/**
 * A string field the database can store. Postgres text and jsonb refuse NUL,
 * and jsonb refuses a lone surrogate, so a value carrying either is refused
 * here as a malformed body instead of failing the write.
 * @param schema - The field's own string rules.
 * @returns The schema with unstorable text refused.
 */
export function storableText(schema: z.ZodType<string>): z.ZodType<string> {
  return schema.refine((s) => !s.includes("\u0000") && !LONE_SURROGATE.test(s));
}

/** With the u flag a well-formed pair is one code point, so only a surrogate with no partner matches. */
const LONE_SURROGATE = /\p{Cs}/u;
