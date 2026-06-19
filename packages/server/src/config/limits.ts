// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Member-capacity limit configuration loader.
 *
 * Loads soft business caps from `config/limits.yaml`: how many active
 * members a studio may have, and how many people may be EXPLICITLY
 * invited to a project (any role). Auto-materialized baseline viewers
 * (open baseline — studio members who just opened the project) are
 * EXEMPT and never counted toward the project cap, so it never blocks
 * viewing access. Concurrency is bounded separately by collab's
 * `max_connections_per_document` (config/collab.yaml).
 *
 * Mirrors the `pricing.ts` / `text-tools.ts` business-config loaders:
 * a yaml file under `config/` validated by a Zod schema and memoized.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/limits.yaml` — both caps default to 100. */
export const limitsConfigSchema = z.object({
  studio_member_cap: z.number().int().positive().default(100),
  project_collaborator_cap: z.number().int().positive().default(100),
});

let _cached: z.infer<typeof limitsConfigSchema> | null = null;

/**
 * Load and cache the member-capacity limits from `config/limits.yaml`.
 * @returns The validated limits config (memoized after the first read).
 * @throws {z.ZodError} if a cap is malformed (non-positive / non-integer).
 */
function loadConfig(): z.infer<typeof limitsConfigSchema> {
  if (_cached) return _cached;
  const dir = resolve(MONOREPO_ROOT, "config");
  const raw = readFileSync(resolve(dir, "limits.yaml"), "utf-8");
  _cached = limitsConfigSchema.parse(parse(raw) as unknown);
  return _cached;
}

/**
 * Max active members allowed in one studio (shared-credit team).
 * @returns The studio member cap.
 */
export function getStudioMemberCap(): number {
  return loadConfig().studio_member_cap;
}

/**
 * Max people EXPLICITLY invited to one project (any role); auto-
 * materialized baseline viewers are exempt and not counted here.
 * @returns The project collaborator cap.
 */
export function getProjectCollaboratorCap(): number {
  return loadConfig().project_collaborator_cap;
}
