// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { REQUEST_SHAPE_REASON } from '@breatic/shared';
import { useSyncExternalStore } from 'react';

import { currentAppVersion, fetchLatestAppVersion } from '@web/data/deployment/use-app-update';
import { muteToasts } from '@web/lib/toast';

let stale = false;
const listeners = new Set<() => void>();

/**
 * Decide, from one refusal, whether this page is too old to keep working.
 *
 * Both halves are needed. The server marks only refusals of a request's own
 * shape, which a page built before a release produces; a live build that
 * differs from this bundle says such a page is what sent it. A shape refusal
 * on the live build is a bug of ours, and a newer live build alone is the
 * ordinary case of a long-open tab, so neither one decides by itself.
 *
 * Callers await this before handing the refusal on, so by the time anyone
 * would show its sentence the toasts are already silent.
 * @param reason - The refusal's `error.reason`, as the server sent it.
 * @returns True once the page is out of date; it stays so until reload.
 */
export async function checkStaleRelease(reason: unknown): Promise<boolean> {
  if (stale) return true;
  if (reason !== REQUEST_SHAPE_REASON) return false;
  const current = currentAppVersion();
  if (!current) return false;
  const latest = await fetchLatestAppVersion();
  if (!latest || latest === current || stale) return stale;
  stale = true;
  muteToasts();
  for (const listener of listeners) listener();
  return true;
}

/**
 * Subscribe to the out-of-date decision.
 * @param listener - Called once, when the page is found out of date.
 * @returns The unsubscribe function.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Read the out-of-date decision.
 * @returns Whether this page must reload to keep working.
 */
function snapshot(): boolean {
  return stale;
}

/**
 * Whether this page has been found out of date.
 * @returns True once a refusal proved it; never false again before reload.
 */
export function useStaleRelease(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Forget the decision between tests; the module outlives a single case. */
export function _resetStaleReleaseForTests(): void {
  stale = false;
}
