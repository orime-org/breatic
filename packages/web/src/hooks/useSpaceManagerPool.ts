/**
 * `useSpaceManagerPool` — LRU pool of canvas Space Yjs managers
 * for a project (v10 spec §11.5 implementation §6.6).
 *
 * V1 behaviour: keep up to N (default 5) canvas-{spaceId} managers
 * alive, sharing a single Hocuspocus websocket. When a 6th Space is
 * requested, the least-recently-used one is destroyed.
 *
 * The pool only handles `canvas` Spaces in V1. `document` and
 * `timeline` kinds are deferred to V2 — adding them is an additive
 * change to this file (kind enum + per-kind manager factory).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  createCanvasSpaceManager,
  type CanvasSpaceManager,
} from '@/utils/yjsCanvasSpaceManager';

const DEFAULT_POOL_SIZE = 5;

interface PoolEntry {
  manager: CanvasSpaceManager;
  lastUsed: number;
}

export interface UseSpaceManagerPoolOptions {
  /** Max canvas-{spaceId} docs kept alive at once. Default 5. */
  poolSize?: number;
  websocketProvider?: HocuspocusProviderWebsocket;
  wsUrl?: string;
  userId?: string;
  onAuthFailed?: (reason: string) => void;
}

export interface UseSpaceManagerPoolResult {
  /**
   * Get-or-create the canvas Space manager for `spaceId`. Calls bump
   * the entry's lastUsed timestamp; returning the same instance for
   * repeated calls within the LRU window.
   */
  getCanvasSpace: (spaceId: string) => CanvasSpaceManager;
  /**
   * Drop the manager for a Space without going through LRU eviction.
   * Use when a Space has been deleted server-side and any cached
   * connection is now stale.
   */
  evict: (spaceId: string) => void;
}

/**
 * Build the pool. The pool is keyed by `(projectId, spaceId)`; when
 * `projectId` changes (user switched projects) the previous pool is
 * destroyed entirely so canvas-{spaceId} docs from the old project
 * don't leak into the new one.
 */
export function useSpaceManagerPool(
  projectId: string | null,
  token: string,
  options: UseSpaceManagerPoolOptions = {},
): UseSpaceManagerPoolResult {
  const {
    poolSize = DEFAULT_POOL_SIZE,
    websocketProvider,
    wsUrl,
    userId,
    onAuthFailed,
  } = options;

  const poolRef = useRef<Map<string, PoolEntry>>(new Map());
  const onAuthFailedRef = useRef(onAuthFailed);
  onAuthFailedRef.current = onAuthFailed;

  // Reset the pool whenever projectId or token rotates — in either
  // case the existing managers reference the wrong project / are
  // authenticated against the wrong session.
  useEffect(() => {
    return () => {
      poolRef.current.forEach((entry) => entry.manager.destroy());
      poolRef.current.clear();
    };
  }, [projectId, token]);

  const evictLruIfFull = useCallback(() => {
    if (poolRef.current.size < poolSize) return;
    let lruKey: string | null = null;
    let lruTs = Infinity;
    poolRef.current.forEach((entry, key) => {
      if (entry.lastUsed < lruTs) {
        lruTs = entry.lastUsed;
        lruKey = key;
      }
    });
    if (lruKey !== null) {
      const evicted = poolRef.current.get(lruKey);
      evicted?.manager.destroy();
      poolRef.current.delete(lruKey);
    }
  }, [poolSize]);

  const getCanvasSpace = useCallback(
    (spaceId: string): CanvasSpaceManager => {
      if (!projectId || !token) {
        throw new Error(
          'useSpaceManagerPool: projectId and token must be set before requesting a Space manager',
        );
      }
      const existing = poolRef.current.get(spaceId);
      if (existing) {
        existing.lastUsed = Date.now();
        return existing.manager;
      }
      evictLruIfFull();
      const manager = createCanvasSpaceManager({
        projectId,
        spaceId,
        token,
        websocketProvider,
        wsUrl,
        userId,
        onAuthFailed: (reason) => onAuthFailedRef.current?.(reason),
      });
      poolRef.current.set(spaceId, { manager, lastUsed: Date.now() });
      return manager;
    },
    [projectId, token, websocketProvider, wsUrl, userId, evictLruIfFull],
  );

  const evict = useCallback((spaceId: string) => {
    const entry = poolRef.current.get(spaceId);
    if (!entry) return;
    entry.manager.destroy();
    poolRef.current.delete(spaceId);
  }, []);

  return { getCanvasSpace, evict };
}
