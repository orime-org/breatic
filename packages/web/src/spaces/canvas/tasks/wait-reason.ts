// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why a task waits for a free running slot (inner#1968, design 3.9 and 21
 * row 22): with the limit it waits under, or without a number when the
 * answer carried none. The limit is the Studio's, counted against the
 * running tasks of whoever started the task, so a user who started it is told
 * "you", anyone else is told about the person who started it, and the counts
 * column, which may hold several tasks from several people, says it of each
 * queued task.
 * @param t - The translate function.
 * @param limit - The limit, or null or undefined when unknown.
 * @param who - `own` for the user's own task, `other` for someone else's, `{ each }` for a node's queued tasks and how many there are.
 * @returns The sentence.
 */
export function waitReason(
  t: (key: string, params?: Record<string, string | number>) => string,
  limit: number | null | undefined,
  who: 'own' | 'other' | { each: number },
): string {
  if (typeof who === 'object') {
    return limit == null ? t('canvas.task.waitReasonEach', { count: who.each }) : t('canvas.task.waitReasonEachLimit', { count: who.each, limit });
  }
  const key = who === 'own' ? 'canvas.task.waitReason' : 'canvas.task.waitReasonOther';
  return limit == null ? t(key) : t(`${key}Limit`, { limit });
}
