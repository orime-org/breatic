// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { z } from "zod";

/**
 * A string field that refuses NUL. Postgres text and jsonb cannot hold it, so
 * a value carrying one is refused here as a malformed body instead of failing
 * the write.
 * @param schema - The field's own string rules.
 * @returns The schema with NUL refused.
 */
export function withoutNul(schema: z.ZodType<string>): z.ZodType<string> {
  return schema.refine((s) => !s.includes("\u0000"));
}
