// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { httpRequest } from '@breatic/shared';
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'breatic:deferred-app-versions';
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
 * @returns The pending release and a tab-scoped dismissal action.
 */
export function useAppUpdate(): { version: string | null; dismiss: () => void } {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    const current = readAppVersion({ version: import.meta.env.VITE_APP_VERSION });
    if (!import.meta.env.PROD || !current) return;
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
        const response = await httpRequest(new URL('/app-version.json', window.location.origin).href, {
          cache: 'no-store', credentials: 'omit',
        }, { replaySafe: true, timeoutMs: 10_000, signal: controller.signal });
        if (!response.ok) return;
        const latest = readAppVersion(await response.json());
        if (!stopped && !controller.signal.aborted && latest) {
          setVersion(latest !== current && !deferred.has(latest) ? latest : null);
        }
      } catch { /* Offline, timeout and malformed JSON are deliberately silent. */ }
      finally {
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
    setVersion(null);
  }, [version]);
  return { version, dismiss };
}
