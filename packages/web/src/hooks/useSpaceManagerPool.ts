/**
 * `useSpaceManagerPool` — LRU pool of Yjs managers, one per Space
 * doc inside a project (v10 spec §11.5 implementation §6.6).
 *
 * V1 behaviour: keep up to N (default 5) per-Space managers alive,
 * sharing a single Hocuspocus websocket. When an N+1th Space is
 * requested, the least-recently-used one is destroyed.
 *
 * Kind dispatch (canvas / document / timeline):
 *   The pool exposes `getSpaceManager(spaceId, kind)` as the
 *   primary entry point. Each kind has its own manager factory and
 *   its own manager interface (canvas → `CanvasSpaceManager` with
 *   `nodesMap`/`edgesMap`; document/timeline → future kinds with
 *   their own shapes). V1 only ships canvas; document and timeline
 *   throw {@link NotImplementedError} so the call sites get a
 *   loud, locatable failure instead of a silent null.
 *
 *   `getCanvasSpace` is kept as a typed convenience alias for the
 *   common path (returns `CanvasSpaceManager` directly without the
 *   union widening that `getSpaceManager` necessarily has).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { SpaceType } from '@breatic/shared';
import {
  createCanvasSpaceManager,
  type CanvasSpaceManager,
} from '@/utils/yjsCanvasSpaceManager';

const DEFAULT_POOL_SIZE = 5;

/**
 * Thrown when the caller asks for a Space kind that has no manager
 * factory yet. Carries the offending kind so the UI layer can surface
 * a "Space type not yet supported" placeholder rather than crashing.
 */
export class NotImplementedError extends Error {
  constructor(public readonly kind: SpaceType) {
    super(`Space kind '${kind}' is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Union of every per-Space manager kind. V1 only contains
 * `CanvasSpaceManager` because document/timeline factories don't
 * exist yet — keeping the alias here makes adding them a
 * straightforward additive change to this module.
 */
export type AnySpaceManager = CanvasSpaceManager;

interface PoolEntry {
  kind: SpaceType;
  manager: AnySpaceManager;
  lastUsed: number;
}

export interface UseSpaceManagerPoolOptions {
  /** Max per-Space docs kept alive at once. Default 5. */
  poolSize?: number;
  websocketProvider?: HocuspocusProviderWebsocket;
  wsUrl?: string;
  userId?: string;
  onAuthFailed?: (reason: string) => void;
}

export interface UseSpaceManagerPoolResult {
  /**
   * Get-or-create a Space manager for `(spaceId, kind)`. Calls bump
   * the entry's lastUsed timestamp; returning the same instance for
   * repeated calls within the LRU window. Throws
   * {@link NotImplementedError} for unsupported kinds.
   */
  getSpaceManager: (spaceId: string, kind: SpaceType) => AnySpaceManager;
  /**
   * Typed convenience for the common canvas path. Equivalent to
   * `getSpaceManager(spaceId, 'canvas')` but with the precise return
   * type. Throws if the cached entry exists with a different kind
   * (defense against UI bugs that pass a non-canvas Space here).
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
 * Build the pool. Keyed by `spaceId` only — the kind is asserted on
 * each access. When `projectId` or `token` rotates the existing pool
 * is destroyed entirely so per-Space connections from the old
 * project/session don't leak into the new one.
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

  const getSpaceManager = useCallback(
    (spaceId: string, kind: SpaceType): AnySpaceManager => {
      if (!projectId || !token) {
        throw new Error(
          'useSpaceManagerPool: projectId and token must be set before requesting a Space manager',
        );
      }
      const existing = poolRef.current.get(spaceId);
      if (existing) {
        if (existing.kind !== kind) {
          // Cached under a different kind — likely a bug in the
          // caller; tear down the wrong entry and fall through to
          // create a fresh one.
          existing.manager.destroy();
          poolRef.current.delete(spaceId);
        } else {
          existing.lastUsed = Date.now();
          return existing.manager;
        }
      }
      evictLruIfFull();

      let manager: AnySpaceManager;
      if (kind === 'canvas') {
        manager = createCanvasSpaceManager({
          projectId,
          spaceId,
          token,
          websocketProvider,
          wsUrl,
          userId,
          onAuthFailed: (reason) => onAuthFailedRef.current?.(reason),
        });
      } else {
        // V1 ships canvas only. document/timeline factories will be
        // added here once those Space kinds are implementable end
        // to end (Yjs schema + server task pipeline + UI).
        throw new NotImplementedError(kind);
      }
      poolRef.current.set(spaceId, { kind, manager, lastUsed: Date.now() });
      return manager;
    },
    [projectId, token, websocketProvider, wsUrl, userId, evictLruIfFull],
  );

  const getCanvasSpace = useCallback(
    (spaceId: string): CanvasSpaceManager => {
      const m = getSpaceManager(spaceId, 'canvas');
      // Narrow: we asked for canvas, factory returned canvas.
      return m;
    },
    [getSpaceManager],
  );

  const evict = useCallback((spaceId: string) => {
    const entry = poolRef.current.get(spaceId);
    if (!entry) return;
    entry.manager.destroy();
    poolRef.current.delete(spaceId);
  }, []);

  return { getSpaceManager, getCanvasSpace, evict };
}
