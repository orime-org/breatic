// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The terms version new accounts are created under, from `config/legal.yaml`.
 *
 * Mirrors the `auth.ts` loader: a yaml file under `config/` validated by a
 * Zod schema and memoized.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/legal.yaml`. The length cap is the column's. */
export const legalConfigSchema = z.object({
  terms_version: z.string().min(1).max(32).default("2026-10-02"),
});

/** The validated contents of `config/legal.yaml`. */
export type LegalConfig = z.infer<typeof legalConfigSchema>;

let _cached: LegalConfig | null = null;

/**
 * Load and cache the legal settings.
 * @returns The validated settings (memoized after the first read).
 * @throws {z.ZodError} if the version is empty or longer than the column.
 */
export function getLegalConfig(): LegalConfig {
  if (_cached) return _cached;
  const raw = readFileSync(resolve(MONOREPO_ROOT, "config", "legal.yaml"), "utf-8");
  _cached = legalConfigSchema.parse(parse(raw) as unknown);
  return _cached;
}
