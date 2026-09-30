// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Understand run loader (#2175).
 *
 * Reads `config/understand.yaml`: what a canvas run reading a node's media
 * into text is allowed to take, in size and in time.
 *
 * Its own file rather than a section of the agent's, because the two are
 * separate runs with separate ceilings — the agent's are sized for a
 * conversation reading several pieces of media in turn, and these are sized
 * for one press producing one task.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const understandConfigSchema = z.object({
  max_media_bytes: z.number().int().positive().default(20_971_520),
  fetch_timeout_ms: z.number().int().positive().default(30_000),
  min_bytes_per_sec: z.number().int().positive().default(65_536),
  read_floor_ms: z.number().int().positive().default(5_000),
  call_timeout_ms: z.number().int().positive().default(180_000),
  max_output_tokens: z.number().int().positive().default(8_192),
});

/** Validated understand configuration. */
export type UnderstandConfig = z.infer<typeof understandConfigSchema>;

let _cached: Readonly<UnderstandConfig> | null = null;

/**
 * Load the understand run's ceilings from YAML.
 * @returns Frozen, validated config, memoized after the first read.
 * @throws {z.ZodError} When a value is malformed.
 */
export function getUnderstandConfig(): Readonly<UnderstandConfig> {
  if (_cached) return _cached;

  const raw = readFileSync(
    resolve(MONOREPO_ROOT, "config/understand.yaml"),
    "utf-8",
  );
  _cached = Object.freeze(understandConfigSchema.parse(parse(raw) as unknown));
  return _cached;
}
