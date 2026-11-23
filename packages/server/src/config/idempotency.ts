// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The product's run-once lease: core's loader over the product's
 * `config/idempotency.yaml`.
 */

import { getRunningLeaseMs as readRunningLeaseMs } from "@breatic/core";

/**
 * How long a running record lives without a renewal.
 * @returns Milliseconds.
 * @throws {z.ZodError} if `config/idempotency.yaml` is malformed.
 */
export function getRunningLeaseMs(): number {
  return readRunningLeaseMs();
}
