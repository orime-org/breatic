// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Why a task waits for a free running slot (inner#1968, design 3.9 and 21
 * row 22): with the limit it waits under, or without a number when the
 * answer carried none.
 * @param t - The translate function.
 * @param limit - The limit, or null or undefined when unknown.
 * @returns The sentence.
 */
export function waitReason(
  t: (key: string, params?: Record<string, string | number>) => string,
  limit: number | null | undefined,
): string {
  return limit == null ? t('canvas.task.waitReason') : t('canvas.task.waitReasonLimit', { limit });
}
