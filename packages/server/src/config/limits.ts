// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Business limits configuration loader.
 *
 * Loads the operator-tunable numbers from `config/limits.yaml`:
 *
 *   - page sizes for the activity feed, the node-history panel and the
 *     credit overlay.
 *   - the canvas reference-pool cap.
 *   - the decision window — how long someone has to answer an invitation, a
 *     transfer, or a role-upgrade request.
 *   - the storage-full notice window — how long one account's "out of
 *     storage" notice silences the next.
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
  activity_feed_page_default: z.number().int().positive().default(50),
  activity_feed_page_max: z.number().int().positive().default(100),
  canvas_reference_pool_cap: z.number().int().positive().default(50),
  node_history_page_size: z.number().int().positive().default(20),
  credit_page_default: z.number().int().positive().default(30),
  credit_page_max: z.number().int().positive().default(100),
  decision_window_days: z.number().int().positive().default(7),
  storage_notice_window_seconds: z.number().int().positive().default(86400),
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
 * Activity-feed keyset page size (default when no `?limit`, and the
 * hard ceiling a client `?limit` is clamped to).
 * @returns `{ default: number, max: number }` page-size bounds.
 */
export function getActivityFeedPageLimits(): { default: number; max: number } {
  const c = loadConfig();
  return { default: c.activity_feed_page_default, max: c.activity_feed_page_max };
}

/**
 * Credit paging bounds for the overlay's purchase list and ledger (default
 * when no `?limit`, and the ceiling a client `?limit` is clamped to).
 * @returns `{ default: number, max: number }` page-size bounds.
 */
export function getCreditPageLimits(): { default: number; max: number } {
  const c = loadConfig();
  return { default: c.credit_page_default, max: c.credit_page_max };
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

/**
 * How long one account's "storage is full" notice silences the next, in
 * seconds (#89). Keyed by the admin's ACCOUNT because the ceiling is an
 * account-wide sum: a team account administering four studios would otherwise
 * get four notices for one event.
 * @returns The notice window in seconds.
 */
export function getStorageNoticeWindowSeconds(): number {
  return loadConfig().storage_notice_window_seconds;
}
