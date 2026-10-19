// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { httpRequest } from '@breatic/shared';
import { useCallback, useEffect, useReducer, useState } from 'react';

import { STORAGE_KEYS } from '@web/lib/storage-keys';

const STORAGE_KEY = STORAGE_KEYS.deferredAppVersions;
const deferred = new Set<string>();
const INTERVAL = 180_000;
const RESUME_DELAY = 30_000;

/**
 * Read only bounded, nonempty release identifiers from untrusted manifests.
 * @param value - Untrusted JSON payload.
 * @returns A release identifier, or null.
 */
export function readAppVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('version' in value)) return null;
  const version = value.version;
  return typeof version === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(version)
    ? version
    : null;
}

/**
 * The release this bundle was built as, in a versioned production build.
 * @returns The build's version, or null where there is nothing to compare.
 */
export function currentAppVersion(): string | null {
  if (!import.meta.env.PROD) return null;
  return readAppVersion({ version: import.meta.env.VITE_APP_VERSION });
}

/**
 * Ask the deployment which release is live, bypassing every cache.
 * @param signal - Aborts the request.
 * @returns The live release, or null when the answer is missing or not ours.
 */
export async function fetchLatestAppVersion(signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await httpRequest(new URL('/app-version.json', window.location.origin).href, {
      cache: 'no-store', credentials: 'omit',
    }, { replaySafe: true, timeoutMs: 10_000, signal });
    if (!response.ok) return null;
    return readAppVersion(await response.json());
  } catch {
    // Offline, timeout and malformed JSON are deliberately silent.
    return null;
  }
}

/** Restore this tab's choices; storage restrictions must not break Project. */
function restoreDeferred(): void {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(saved)) {
      for (const value of saved) {
        const version = readAppVersion({ version: value });
        if (version) deferred.add(version);
      }
    }
  } catch { /* In-memory dismissal still works when storage is unavailable. */ }
}

/**
 * Observe releases only while Project is mounted, without changing document state.
 * A postponed release stays reported, so the top bar keeps offering it; only
 * opening it by itself is what Later turns off.
 * @returns The live release when it differs from this bundle, whether it should
 * open by itself, and a tab-scoped postpone action.
 */
export function useAppUpdate(): { version: string | null; autoOpen: boolean; dismiss: () => void } {
  const [version, setVersion] = useState<string | null>(null);
  // `deferred` lives outside React; this re-renders after Later changes it.
  const [, postponed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const current = currentAppVersion();
    if (!current) return;
    restoreDeferred();
    let stopped = false;
    let lastCheck = -Infinity;
    let pending: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** Schedule the next request with jitter to spread release traffic. */
    function schedule(): void {
      if (!stopped && document.visibilityState !== 'hidden') {
        timer = setTimeout(() => { void check(); }, INTERVAL + Math.random() * 30_000);
      }
    }

    /** Fetch silently; a rollback is also a release different from this bundle. */
    async function check(): Promise<void> {
      if (stopped || pending || document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      lastCheck = Date.now();
      const controller = new AbortController();
      pending = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const latest = await fetchLatestAppVersion(controller.signal);
        if (!stopped && !controller.signal.aborted && latest) {
          setVersion(latest !== current ? latest : null);
        }
      } finally {
        clearTimeout(timeout);
        pending = undefined;
        schedule();
      }
    }

    /** Pause hidden tabs and throttle repeated foreground transitions. */
    function onVisibility(): void {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        pending?.abort();
      } else if (!pending) {
        if (Date.now() - lastCheck >= RESUME_DELAY) void check();
        else schedule();
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
      pending?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const dismiss = useCallback((): void => {
    if (!version) return;
    deferred.add(version);
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...deferred])); }
    catch { /* Retain the in-memory choice for this tab. */ }
    postponed();
  }, [version]);
  return { version, autoOpen: version !== null && !deferred.has(version), dismiss };
}
