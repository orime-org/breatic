// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MediaWarning } from "@provider/media/runner.js";

/** What WaveSpeed's billing search answered for one prediction. */
export type BillingRead =
  | { kind: "total"; usd: number; warnings: MediaWarning[] }
  | { kind: "none"; warnings: MediaWarning[] };

/**
 * Read a billing search answer: deductions less refunds, never below zero;
 * lines of any other type left out; no deduction at all is no answer yet.
 * @param body - The parsed response body.
 * @returns The total, or none.
 */
export function readBilling(body: unknown): BillingRead {
  void body;
  throw new Error("readBilling is not implemented");
}
