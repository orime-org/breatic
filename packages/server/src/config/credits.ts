// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Credits configuration loader: `config/credits.yaml`, a deployment's own
 * file (the repository ships `config/credits.yaml.template`).
 *
 * It holds how many credits a new account is granted with its personal
 * studio. Read here and passed into the grant: the domain layer cannot reach
 * the file, and how much to give is an input to granting rather than
 * something granting knows.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/credits.yaml`. */
export const creditsConfigSchema = z.object({
  trial_grant: z
    .object({
      // Non-negative rather than positive: zero is a real value here, and it
      // is how a deployment turns the grant off without removing the section.
      credits: z.number().int().nonnegative().default(0),
    })
    .default({ credits: 0 }),
});

/** Parsed files, one per configuration directory. */
const cached = new Map<string, z.infer<typeof creditsConfigSchema>>();

/**
 * How many credits a new account is granted with its personal studio.
 * @param configDir - The configuration directory; the product's `config/` when absent.
 * @returns The configured figure; zero when the deployment grants none.
 * @throws {Error} When the file is missing or malformed.
 */
export function getTrialGrantCredits(configDir: string = resolve(MONOREPO_ROOT, "config")): number {
  let parsed = cached.get(configDir);
  if (!parsed) {
    const file = resolve(configDir, "credits.yaml");
    if (!existsSync(file)) {
      throw new Error(
        `${file} is missing: copy config/credits.yaml.template there and set trial_grant.credits to the value this deployment had under trial_grant in config/pricing.yaml`,
      );
    }
    // A file holding only comments parses to null and means every section left out.
    parsed = creditsConfigSchema.parse((parse(readFileSync(file, "utf-8")) as unknown) ?? {});
    cached.set(configDir, parsed);
  }
  return parsed.trial_grant.credits;
}
