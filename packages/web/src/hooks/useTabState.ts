/**
 * `useTabState(projectId, userId, metaManager)` — read/write the
 * caller's per-user tab state in `meta.userStates[userId]`
 * (v10 §5.3.1 / §8).
 *
 * Stored fields per user (Y.Map):
 *   - `lastActiveTabId`: spaceId or null
 *   - `openTabs`: Y.Array<spaceId>  — UI tab order on this device
 *   - `lastVisitedAt`: number       — epoch ms
 *
 * Yjs CRDT auto-merges per-user keys, so other collaborators see
 * the same Y.Map but their entries are isolated from this user's.
 *
 * Writes are debounced (1 s, per spec §8.2) so dragging the active
 * tab back and forth doesn't churn the doc. Reads happen once at
 * mount (spec §8.3 — "首次进入读一次,之后由本设备驱动"), so cross-
 * device sync only refreshes on the next page load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { ProjectMetaManager } from '@/utils/yjsProjectMetaManager';

export interface TabState {
  lastActiveTabId: string | null;
  openTabs: string[];
  lastVisitedAt: number;
}

const DEFAULT_TAB_STATE: TabState = {
  lastActiveTabId: null,
  openTabs: [],
  lastVisitedAt: 0,
};

const WRITE_DEBOUNCE_MS = 1000;

function readUserState(userStates: Y.Map<unknown>, userId: string): TabState {
  const entry = userStates.get(userId);
  if (!(entry instanceof Y.Map)) return { ...DEFAULT_TAB_STATE };
  const lastActiveTabId = entry.get('lastActiveTabId');
  const openTabsArr = entry.get('openTabs');
  const lastVisitedAt = entry.get('lastVisitedAt');
  return {
    lastActiveTabId:
      typeof lastActiveTabId === 'string' ? lastActiveTabId : null,
    openTabs:
      openTabsArr instanceof Y.Array
        ? openTabsArr.toArray().filter((s): s is string => typeof s === 'string')
        : [],
    lastVisitedAt:
      typeof lastVisitedAt === 'number' ? lastVisitedAt : 0,
  };
}

function writeUserState(
  userStates: Y.Map<unknown>,
  userId: string,
  next: TabState,
): void {
  let entry = userStates.get(userId);
  if (!(entry instanceof Y.Map)) {
    entry = new Y.Map();
    userStates.set(userId, entry);
  }
  const map = entry as Y.Map<unknown>;
  // Wrap the multi-key write in a transact so collaborators see the
  // updated tab state as a single change rather than a dribble of
  // intermediate states.
  map.doc?.transact(() => {
    map.set('lastActiveTabId', next.lastActiveTabId);
    let openTabsArr = map.get('openTabs');
    if (!(openTabsArr instanceof Y.Array)) {
      openTabsArr = new Y.Array();
      map.set('openTabs', openTabsArr);
    }
    const arr = openTabsArr as Y.Array<string>;
    // Replace contents in place — simpler than diffing.
    if (arr.length > 0) arr.delete(0, arr.length);
    if (next.openTabs.length > 0) arr.push(next.openTabs.slice());
    map.set('lastVisitedAt', next.lastVisitedAt);
  });
}

export interface UseTabStateResult {
  /** Read-once-then-local-driven tab state per spec §8.3. */
  state: TabState;
  /** Patch + (debounced) flush to Yjs. */
  setState: (patch: Partial<TabState>) => void;
}

export function useTabState(
  projectId: string | null,
  userId: string | null,
  metaManager: ProjectMetaManager | null,
): UseTabStateResult {
  const [state, setStateLocal] = useState<TabState>(() => ({ ...DEFAULT_TAB_STATE }));
  const stateRef = useRef<TabState>(state);
  stateRef.current = state;

  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);

  // Initial read (once per (project, user, manager)) — see §8.3.
  useEffect(() => {
    if (!projectId || !userId || !metaManager) return;

    const apply = () => {
      const initial = readUserState(metaManager.userStates, userId);
      stateRef.current = initial;
      setStateLocal(initial);
    };

    if (metaManager.synced) {
      apply();
    } else {
      const unsub = metaManager.onSynced(apply);
      return () => unsub();
    }
    return undefined;
  }, [projectId, userId, metaManager]);

  // Cleanup pending flush when the manager / user goes away.
  useEffect(() => {
    return () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, [projectId, userId, metaManager]);

  const flush = useCallback(() => {
    if (!metaManager || !userId || !dirtyRef.current) return;
    writeUserState(metaManager.userStates, userId, stateRef.current);
    dirtyRef.current = false;
  }, [metaManager, userId]);

  const setState = useCallback(
    (patch: Partial<TabState>) => {
      setStateLocal((prev) => {
        const next = { ...prev, ...patch, lastVisitedAt: Date.now() };
        stateRef.current = next;
        dirtyRef.current = true;
        if (flushTimer.current) clearTimeout(flushTimer.current);
        flushTimer.current = setTimeout(flush, WRITE_DEBOUNCE_MS);
        return next;
      });
    },
    [flush],
  );

  return { state, setState };
}
