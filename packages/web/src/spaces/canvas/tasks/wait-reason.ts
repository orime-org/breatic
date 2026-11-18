// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Why a task waits for a free running slot (inner#1968, design 3.9 and 21
 * row 22): with the limit it waits under, or without a number when the
 * answer carried none. The limit is its starter's, so a reader who started
 * it is told "you" and anyone else is told about the person who started it.
 * @param t - The translate function.
 * @param limit - The limit, or null or undefined when unknown.
 * @param own - Whether the reader started it.
 * @returns The sentence.
 */
export function waitReason(
  t: (key: string, params?: Record<string, string | number>) => string,
  limit: number | null | undefined,
  own: boolean,
): string {
  const key = own ? 'canvas.task.waitReason' : 'canvas.task.waitReasonOther';
  return limit == null ? t(key) : t(`${key}Limit`, { limit });
}
