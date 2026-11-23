// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The product's per-action throttles: core's loader over the product's
 * `config/rate-limits.yaml`. Every limiter and every direct reader in this
 * service takes its numbers from here.
 */

import { getRateLimit as readRateLimit } from "@breatic/core";

/**
 * One action's window from the product's `config/rate-limits.yaml`.
 * @param action - The throttle action (yaml key and Redis prefix).
 * @returns `{ max, windowSeconds }` for the action.
 * @throws {Error} when the action has no entry or the file is malformed.
 */
export function getRateLimit(action: string): { max: number; windowSeconds: number } {
  return readRateLimit(action);
}
