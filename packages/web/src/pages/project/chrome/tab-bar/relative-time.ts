// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Bucketed relative-time descriptor (key + ICU plural params).
 * Pure — returns the ICU message id to feed `t(rel.key, rel.params)`.
 */
export interface RelativeTime {
  key:
    | 'activity.relative.justNow'
    | 'activity.relative.minutesAgo'
    | 'activity.relative.hoursAgo'
    | 'activity.relative.yesterday'
    | 'activity.relative.daysAgo'
    | 'activity.relative.weeksAgo'
    | 'activity.relative.monthsAgo'
    | 'activity.relative.isoDate';
  params?: Record<string, string | number>;
}

/**
 * Buckets a past timestamp into a relative-time ICU descriptor
 * (just now / minutes / hours / yesterday / days / weeks / months / ISO date).
 *
 * Shared by the two panels in this folder so a moment reads the same in both.
 * The `activity.relative.*` key namespace is where these messages have lived
 * since the activity panel was the only reader.
 * @param epochMs - The timestamp in epoch milliseconds.
 * @param now - Reference "now" in epoch milliseconds; defaults to the current time.
 * @returns The ICU message key plus optional plural params for `t(...)`.
 */
export function relativeTime(epochMs: number, now = Date.now()): RelativeTime {
  if (!Number.isFinite(epochMs))
    return {
      key: 'activity.relative.isoDate',
      params: { date: String(epochMs) },
    };
  const diffMs = now - epochMs;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return { key: 'activity.relative.justNow' };
  if (min < 60)
    return { key: 'activity.relative.minutesAgo', params: { count: min } };
  const hr = Math.floor(min / 60);
  if (hr < 24)
    return { key: 'activity.relative.hoursAgo', params: { count: hr } };
  if (hr < 48) return { key: 'activity.relative.yesterday' };
  const day = Math.floor(hr / 24);
  if (day < 7)
    return { key: 'activity.relative.daysAgo', params: { count: day } };
  if (day < 30)
    return {
      key: 'activity.relative.weeksAgo',
      params: { count: Math.floor(day / 7) },
    };
  if (day < 365)
    return {
      key: 'activity.relative.monthsAgo',
      params: { count: Math.floor(day / 30) },
    };
  return {
    key: 'activity.relative.isoDate',
    params: { date: new Date(epochMs).toISOString().slice(0, 10) },
  };
}
