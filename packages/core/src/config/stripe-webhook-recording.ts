// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@core/config/env.js";

const recordingSchema = z.object({
  write_statement_timeout_ms: z.number().int().positive().default(2000),
});

let cached: Readonly<z.infer<typeof recordingSchema>> | null = null;

/**
 * Read the database statement budget used by webhook recording transactions.
 * @returns The configured statement timeout in milliseconds.
 * @throws {Error} When the configuration file cannot be read.
 * @throws {z.ZodError} When the configured budget is invalid.
 */
export function getStripeWebhookRecordingWriteTimeoutMs(): number {
  if (cached === null) {
    const contents = readFileSync(resolve(MONOREPO_ROOT, "config/stripe-webhook-recording.yaml"), "utf8");
    cached = Object.freeze(recordingSchema.parse(parse(contents) as unknown));
  }
  return cached.write_statement_timeout_ms;
}
