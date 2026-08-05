// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Business limits configuration loader.
 *
 * Loads the operator-tunable numbers from `config/limits.yaml`:
 *
 *   - soft capacity caps — how many active members a studio may have, and how
 *     many people may be EXPLICITLY invited to a project (any role).
 *     Auto-materialized baseline viewers (open baseline — studio members who
 *     just opened the project) are EXEMPT and never counted toward the project
 *     cap, so it never blocks viewing access. Concurrency is bounded
 *     separately by collab's `max_connections_per_document`
 *     (config/collab.yaml).
 *   - page sizes for the activity feed and the node-history panel.
 *   - the decision window — how long someone has to answer an invitation, a
 *     transfer, or a role-upgrade request.
 *
 * Mirrors the `pricing.ts` / `text-tools.ts` business-config loaders:
 * a yaml file under `config/` validated by a Zod schema and memoized.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { MONOREPO_ROOT } from "@breatic/core";

/** Schema for `config/limits.yaml`. */
export const limitsConfigSchema = z.object({
  studio_member_cap: z.number().int().positive().default(100),
  project_collaborator_cap: z.number().int().positive().default(100),
  activity_feed_page_default: z.number().int().positive().default(50),
  activity_feed_page_max: z.number().int().positive().default(100),
  canvas_reference_pool_cap: z.number().int().positive().default(50),
  node_history_page_size: z.number().int().positive().default(20),
  decision_window_days: z.number().int().positive().default(7),
});

/** Hours per day × minutes per hour × seconds per minute — written once. */
const SECONDS_PER_DAY = 24 * 60 * 60;

let _cached: z.infer<typeof limitsConfigSchema> | null = null;

/**
 * Load and cache the business limits from `config/limits.yaml`.
 * @returns The validated limits config (memoized after the first read).
 * @throws {z.ZodError} if a value is malformed (non-positive / non-integer).
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

/**
 * Activity-feed keyset page size (default when no `?limit`, and the
 * hard ceiling a client `?limit` is clamped to).
 * @returns `{ default: number, max: number }` page-size bounds.
 */
export function getActivityFeedPageLimits(): { default: number; max: number } {
  const c = loadConfig();
  return { default: c.activity_feed_page_default, max: c.activity_feed_page_max };
}

/**
 * Max entries in one canvas node's reference pool — incoming reference
 * edges + focus crops combined (#1782). Served to the frontend via
 * `GET /canvas/limits`; the frontend enforces it at add time (the pool
 * lives in Yjs, the server never gates collaborative writes).
 * @returns The per-node reference-pool cap.
 */
export function getCanvasReferencePoolCap(): number {
  return loadConfig().canvas_reference_pool_cap;
}

/**
 * Page size the frontend requests per infinite-scroll page of a node's
 * history (#1619). Served to the frontend via `GET /canvas/limits`.
 * @returns The node-history page size.
 */
export function getNodeHistoryPageSize(): number {
  return loadConfig().node_history_page_size;
}

/**
 * A day in milliseconds, for readers converting a span back into days.
 *
 * Not a window and not a TTL — the unit itself. The landing page divides
 * `expires_at - created_at` by it to say how long a request had, which is a
 * question about a row rather than about today's configuration.
 */
export const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/**
 * How long someone has to answer something waiting on them, in days.
 *
 * One window for all five such flows — studio invite, project invite,
 * studio transfer, project transfer, role-upgrade request. Use this one
 * when the number is being SHOWN to a person (an email sentence, a page
 * that explains why a link stopped working); use `getDecisionWindowMs` or
 * `getDecisionWindowSeconds` when it is being computed with.
 *
 * Not for account-security lifetimes. Password reset, email verification,
 * sessions and recovery codes are each set against their own threat and
 * live where they are used.
 * @returns The decision window in days.
 */
export function getDecisionWindowDays(): number {
  return loadConfig().decision_window_days;
}

/**
 * The same window in milliseconds, for `Date.now() + window`.
 *
 * The conversion lives here rather than at each deadline write: spelled out
 * at every call site, it is one transcription error away from two flows
 * disagreeing about the same window. Derived from the seconds form rather
 * than from days again, so the day→second factor is applied in exactly one
 * place.
 * @returns The decision window in milliseconds.
 */
export function getDecisionWindowMs(): number {
  return getDecisionWindowSeconds() * 1000;
}

/**
 * The same window in seconds, for callers that need the duration rather than
 * the instant — anything that takes "how long" instead of "until when".
 * `no-hardcoded-request-ttl` names this function as the way out, which is part
 * of why it exists: without it the only escape from the rule would be to write
 * a day out by hand.
 * @returns The decision window in seconds.
 */
export function getDecisionWindowSeconds(): number {
  return getDecisionWindowDays() * SECONDS_PER_DAY;
}
