// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import * as Y from 'yjs';

import type { SpaceType } from '@web/spaces';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket, type ConnectionStatus } from '@web/data/yjs/use-socket';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * Project meta Yjs document — single source of truth for the project's
 * spaces list, plus per-user UI state (the open-tab bar).
 *
 * Y.Doc structure:
 *
 *   spaces:  Y.Map<spaceId, Y.Map<{ id, name, type, locked? }>>  shared (all members)
 *   perUser: Y.Map<userId, Y.Map<{ openTabIds: Y.Array<string> }>>  per-user tab bar
 *
 * The ACTIVE tab is deliberately NOT in this doc (user 2026-07-11): it is
 * local window state (`ProjectPage` useState). It used to live here as
 * `perUser[userId].activeSpaceId`, but two machines on the SAME account
 * both live-subscribe to the same subtree — machine A clicking a tab
 * flipped machine B's active tab and remounted B's running space body,
 * interrupting its in-flight work. A legacy `activeSpaceId` key may still
 * exist in old docs; it is never read or written anymore. Opening a
 * project defaults to the first open tab.
 *
 * Why the tab list still lives in the shared doc (not localStorage or an
 * isolated awareness state):
 *   - Awareness is session-scoped — switching machines loses the work
 *     scene (which tabs were open).
 *   - Hocuspocus persists the Y.Doc to PG, so per-user keys persist by
 *     default — a user logging in on a new machine receives the full
 *     Y.Doc on sync and restores their open tabs in one round trip.
 *   - Yjs CRDT semantics scope writes by Y.Map key (userId); a malicious
 *     client trying to write another user's key is rejected by the
 *     Hocuspocus `beforeHandleMessage` extension (collab F.2 hook).
 *
 * Write boundaries:
 *   - Shared `spaces` writes (create / delete / lock / rename) round-trip
 *     through the collab process as stateless RPCs on the live meta-doc
 *     WebSocket (`sendSpaceRpc` → collab `services/space-rpc.ts`, per ADR
 *     2026-05-23 yjs-collab-only-write-authz): collab authorizes the role,
 *     applies the privileged Yjs write + audit entry, and Yjs broadcasts
 *     the change. The client does NOT write `spaces` directly.
 *   - Per-user writes (`openSpaceTab` / `closeSpaceTab`) write the
 *     client's OWN `perUser[userId]` subtree directly; the Hocuspocus
 *     extension ensures the user can't write another user's subtree.
 */

const SPACES_KEY = 'spaces';
const PER_USER_KEY = 'perUser';
const OPEN_TAB_IDS_KEY = 'openTabIds';
/**
 * Y.Map<userId, { name, avatarUrl }> seeded at project creation by the
 * meta bootstrap and kept live by collab's awareness projection
 * (`hooks/awareness-meta-users.ts`, which replaced the earlier
 * handshake-time upsert - PR #153). Consumers (ProjectMessagesButton
 * activity panel, MembersStack, canvas handlingBy rendering, future
 * presence overlays) look up display names via this map so a username
 * rename propagates live. See Q11 v2 design (2026-05-26).
 */
const USERS_KEY = 'users';

export interface ProjectSpace {
  id: string;
  name: string;
  type: SpaceType;
  locked?: boolean;
}

/** Live user record stored in `meta.users[userId]`. */
export interface ProjectUser {
  id: string;
  name: string;
  avatarUrl: string | null;
  /**
   * Timestamp (ms) of the most recent awareness update for this
   * user as persisted by the collab onAwarenessUpdate hook. Used
   * for "last active N min ago" rendering when the user is
   * currently offline. Optional because seeded entries may predate
   * the field; treat missing as "unknown".
   */
  lastSeenAt?: number;
}

export interface ProjectMetaState {
  spaces: ReadonlyArray<ProjectSpace>;
  /** Spaces the current user has open in their tab bar. */
  openTabIds: ReadonlyArray<string>;
  /**
   * Live map of `userId → { name, avatarUrl, lastSeenAt }` for
   * everyone who has connected to this project's meta doc.
   * ProjectMessagesButton looks up `users[m.actor]?.name` to render
   * display names so rename propagates retroactively. Map shape,
   * not array, because callsites lookup by id far more often than
   * iterate.
   */
  users: ReadonlyMap<string, ProjectUser>;
  /**
   * Live set of `userId`s currently online (have an active
   * awareness entry on the meta doc). Derived from
   * `provider.awareness.getStates()`; updates whenever any peer
   * connects, disconnects, or rewrites their awareness state.
   * Empty until the first awareness change fires (or the provider
   * is null).
   */
  onlineUserIds: ReadonlySet<string>;
  /** True after the initial Hocuspocus sync completes. */
  synced: boolean;
  /**
   * Live Hocuspocus provider for the project's meta doc. Callers that
   * need to issue Space-lifecycle RPCs (`sendSpaceRpc`) pass this in.
   * `null` while the socket is still mounting.
   */
  provider: HocuspocusProvider | null;
  /** High-level connection lifecycle for `ConnectionBanner`. */
  status: ConnectionStatus;
  /** Server-provided auth-failure reason (only set when status='authFailed'). */
  authFailedReason: string | null;
}

/**
 * Subscribe to a project's meta document. Returns the live spaces list
 * + this user's open tabs; updates trigger re-renders. The ACTIVE tab is
 * local page state, not part of this projection (see the module doc).
 *
 * `userId` is required to read the per-user subtree. If undefined (e.g.
 * pre-auth dev mode), the hook falls back to "all spaces open" so the UI
 * doesn't blank out.
 * @param projectId - Project whose meta document to subscribe to.
 * @param userId - Current user, used to read their per-user tab subtree; optional pre-auth.
 * @returns Live meta state: spaces, this user's tabs, online users, provider, and connection status.
 */
export function useProjectMeta(
  projectId: string,
  userId?: string,
): ProjectMetaState {
  const doc = React.useMemo(
    () => getDoc(docName.projectMeta(projectId)),
    [projectId],
  );
  const { synced, provider, status, authFailedReason } = useSocket({
    name: docName.projectMeta(projectId),
    doc,
  });

  const [state, setState] = React.useState<{
    spaces: ReadonlyArray<ProjectSpace>;
    openTabIds: ReadonlyArray<string>;
    users: ReadonlyMap<string, ProjectUser>;
  }>(() => readMetaState(doc, userId));

  React.useEffect(() => {
    /**
     * Re-read spaces / per-user / users state from the doc into React state.
     * @returns Nothing.
     */
    const update = (): void => setState(readMetaState(doc, userId));
    // SPACES is a Y.Map keyed by spaceId on the collab side (see
    // `packages/collab/src/space-rpc.ts` + `auth.ts` +
    // `core/src/db/yjs-bootstrap.ts`). Client must observe the same
    // root collection or Yjs treats `getArray("spaces")` and
    // `getMap("spaces")` as separate, ghost roots and sync silently
    // never lands changes here — see PR-b post-merge bug.
    const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
    const perUser = doc.getMap<Y.Map<unknown>>(PER_USER_KEY);
    const users = doc.getMap<Y.Map<unknown>>(USERS_KEY);
    spacesMap.observeDeep(update);
    perUser.observeDeep(update);
    users.observeDeep(update);
    update();
    return () => {
      spacesMap.unobserveDeep(update);
      perUser.unobserveDeep(update);
      users.unobserveDeep(update);
    };
  }, [doc, userId]);

  // 2026-05-27 (awareness rewrite) — project current user identity
  // into Yjs awareness. Backend's `onAwarenessUpdate` hook persists
  // the snapshot into `meta.users[userId]`. Awareness is declarative
  // — `setLocalStateField` re-fires whenever `currentUser` changes
  // (rename / avatar update via settings → React Query invalidate →
  // store update → this effect re-runs), so identity stays in sync
  // without manual `sendStateless` bookkeeping. Yjs internally diffs
  // and only broadcasts when the serialized value actually changes,
  // so a re-render with unchanged `currentUser` is free.
  const currentUser = useCurrentUserStore((s) => s.user);
  React.useEffect(() => {
    if (!provider || !provider.awareness || !currentUser) return;
    provider.awareness.setLocalStateField('user', {
      id: currentUser.id,
      name: currentUser.name,
      avatarUrl: currentUser.avatarUrl ?? null,
    });
  }, [provider, currentUser]);

  // Track the live set of online users by subscribing to the
  // awareness instance. The collab `onAwarenessUpdate` hook
  // persists name/avatar into meta.users on every awareness change,
  // so the persisted record stays fresh; this subscription only
  // covers "is the user currently online" (a derived ephemeral
  // signal not worth stuffing into Y.Doc state). Combined with
  // `users[userId].lastSeenAt` the UI can render
  // "online" vs "last active N min ago" without polling.
  const [onlineUserIds, setOnlineUserIds] = React.useState<
    ReadonlySet<string>
  >(() => new Set());
  React.useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) {
      setOnlineUserIds(new Set());
      return;
    }
    /**
     * Recompute the set of currently-online user ids from awareness states.
     */
    const update = (): void => {
      const next = new Set<string>();
      awareness.getStates().forEach((state) => {
        const userField = (state as { user?: { id?: unknown } }).user;
        if (userField && typeof userField.id === 'string') {
          next.add(userField.id);
        }
      });
      setOnlineUserIds(next);
    };
    awareness.on('change', update);
    update();
    return () => {
      awareness.off('change', update);
    };
  }, [provider]);

  return {
    ...state,
    onlineUserIds,
    synced,
    provider,
    status,
    authFailedReason,
  };
}

/**
 * Open a Space tab for the given user. No-op if the tab is already
 * open. Always appends at the end of `openTabIds` so the most recently
 * opened tab is rightmost — matches user expectation that "new things
 * appear on the right".
 *
 * Q6 first-write snapshot: when this is the very first interaction
 * for `userId` on the project (no `openTabIds` Y.Array yet), seed the
 * array with ALL currently-visible Space ids before appending the
 * requested one. Without the snapshot, the user's first click /
 * create would set `openTabIds = [thatOneId]` — and the
 * `readMetaState` `!userMap`-fallback (`openTabIds: [spaces[0].id]`)
 * would no longer fire, so every Space EXCEPT the one just opened
 * would silently disappear from the tab bar (`Y.Map.forEach` order
 * is not insertion order, so even the "first" tab is unstable).
 * @param projectId - Project whose meta document holds the per-user tabs.
 * @param userId - User whose tab bar to open the Space in.
 * @param spaceId - Space to open as a tab.
 */
export function openSpaceTab(
  projectId: string,
  userId: string,
  spaceId: string,
): void {
  const doc = getDoc(docName.projectMeta(projectId));
  doc.transact(() => {
    const userMap = ensureUserMap(doc, userId);
    const openTabIds = userMap.get(OPEN_TAB_IDS_KEY) as
      | Y.Array<string>
      | undefined;
    if (!openTabIds) {
      // First-write snapshot — see docstring (Q6).
      const arr = new Y.Array<string>();
      userMap.set(OPEN_TAB_IDS_KEY, arr);
      const allSpaceIds = Array.from(
        doc.getMap<Y.Map<unknown>>(SPACES_KEY).keys(),
      );
      const initial = allSpaceIds.includes(spaceId)
        ? allSpaceIds
        : [...allSpaceIds, spaceId];
      arr.push(initial);
      return;
    }
    const existing = openTabIds.toArray();
    if (!existing.includes(spaceId)) openTabIds.push([spaceId]);
  });
}

/**
 * Plan the per-user tab reconcile after the project's spaces change. Returns
 * which open-tab ids have VANISHED (deleted locally or by a collaborator — no
 * longer in `liveSpaceIds`) and, when the active space is among the vanished,
 * which still-live open tab to activate instead: the first remaining open tab,
 * or null for the empty state. Pure — the caller applies the result via
 * {@link closeSpaceTab} / {@link setActiveSpace}. `reactivateTo === undefined`
 * means the active space is still live, so leave it alone (no-op).
 * @param openTabIds - This user's open-tab space ids.
 * @param liveSpaceIds - The set of space ids that still exist in the project.
 * @param activeSpaceId - This user's active space id (or null).
 * @returns The tab ids to close and the next active id (undefined = no change).
 */
export function planVanishedSpaceReconcile(
  openTabIds: ReadonlyArray<string>,
  liveSpaceIds: ReadonlySet<string>,
  activeSpaceId: string | null,
): { tabsToClose: string[]; reactivateTo: string | null | undefined } {
  const tabsToClose = openTabIds.filter((id) => !liveSpaceIds.has(id));
  const reactivateTo =
    activeSpaceId !== null && !liveSpaceIds.has(activeSpaceId)
      ? (openTabIds.find((id) => liveSpaceIds.has(id)) ?? null)
      : undefined;
  return { tabsToClose, reactivateTo };
}

/**
 * Close a Space tab for the given user. No-op if the tab is not open.
 * Does NOT delete the Space — the Space stays in `spaces`; the user's
 * tab bar just stops showing it. To fully delete a Space, call the
 * server `DELETE /spaces/:id` endpoint.
 * @param projectId - Project whose meta document holds the per-user tabs.
 * @param userId - User whose tab bar to close the Space in.
 * @param spaceId - Space tab to close.
 */
export function closeSpaceTab(
  projectId: string,
  userId: string,
  spaceId: string,
): void {
  const doc = getDoc(docName.projectMeta(projectId));
  doc.transact(() => {
    const userMap = ensureUserMap(doc, userId);
    const arr = userMap.get(OPEN_TAB_IDS_KEY) as Y.Array<string> | undefined;
    if (!arr) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr.get(i) === spaceId) arr.delete(i, 1);
    }
  });
}

/**
 * Legacy direct-write helper, kept for tests and demo scaffolding only.
 * Production code creates Spaces via
 * `sendSpaceRpc({ type: 'space:create', ... })`; a direct client write
 * here is rejected by `beforeHandleMessage` in collab in connected sessions.
 * @param projectId - Project whose meta document to write the Space into.
 * @param space - The Space record to append.
 * @internal
 */
export function appendSpace(projectId: string, space: ProjectSpace): void {
  const doc = getDoc(docName.projectMeta(projectId));
  const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
  doc.transact(() => {
    const entry = new Y.Map<unknown>();
    entry.set('id', space.id);
    entry.set('name', space.name);
    entry.set('type', space.type);
    if (space.locked) entry.set('locked', true);
    spacesMap.set(space.id, entry);
  });
}

/**
 * Legacy direct-write helper, kept for tests and demo scaffolding only.
 * Production code deletes Spaces via
 * `sendSpaceRpc({ type: 'space:delete', ... })`.
 * @param projectId - Project whose meta document to remove the Space from.
 * @param spaceId - Id of the Space to remove.
 * @internal
 */
export function removeSpace(projectId: string, spaceId: string): void {
  const doc = getDoc(docName.projectMeta(projectId));
  const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
  doc.transact(() => {
    if (spacesMap.has(spaceId)) spacesMap.delete(spaceId);
  });
}

/**
 * Get-or-create the `perUser[userId]` Y.Map subtree for a user.
 * @param doc - The project meta Y.Doc.
 * @param userId - User whose per-user subtree to return.
 * @returns The user's per-user Y.Map, created if it did not exist.
 */
function ensureUserMap(doc: Y.Doc, userId: string): Y.Map<unknown> {
  const perUser = doc.getMap<Y.Map<unknown>>(PER_USER_KEY);
  let userMap = perUser.get(userId);
  if (!userMap) {
    userMap = new Y.Map<unknown>();
    perUser.set(userId, userMap);
  }
  return userMap;
}

/**
 * Read all spaces from the doc's `spaces` map into a plain array.
 * @param doc - The project meta Y.Doc to read from.
 * @returns The current project spaces, with defaults applied for missing fields.
 */
function readSpaces(doc: Y.Doc): ReadonlyArray<ProjectSpace> {
  const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
  const out: ProjectSpace[] = [];
  spacesMap.forEach((m) => {
    out.push({
      id: String(m.get('id') ?? ''),
      name: String(m.get('name') ?? ''),
      type: (m.get('type') as SpaceType) ?? 'canvas',
      locked: Boolean(m.get('locked') ?? false),
    });
  });
  return out;
}

/**
 * Read the live `meta.users` map into a `userId → ProjectUser` map.
 * @param doc - The project meta Y.Doc to read from.
 * @returns The known users keyed by id, with defaults applied for missing fields.
 */
function readUsers(doc: Y.Doc): ReadonlyMap<string, ProjectUser> {
  const usersMap = doc.getMap<Y.Map<unknown>>(USERS_KEY);
  const out = new Map<string, ProjectUser>();
  usersMap.forEach((m, userId) => {
    if (!(m instanceof Y.Map)) return;
    const lastSeenRaw = m.get('lastSeenAt');
    out.set(userId, {
      id: String(m.get('id') ?? userId),
      name: String(m.get('name') ?? ''),
      avatarUrl: (m.get('avatarUrl') as string | null) ?? null,
      lastSeenAt:
        typeof lastSeenRaw === 'number' ? lastSeenRaw : undefined,
    });
  });
  return out;
}

/**
 * Project the meta doc into the React-facing state shape for one user,
 * applying the pre-auth and first-visit "all spaces open" fallbacks. The
 * active tab is NOT part of this projection — it is local page state, so a
 * remote machine's writes can never flip it (a legacy `activeSpaceId` key in
 * old docs is deliberately ignored).
 * @param doc - The project meta Y.Doc to read from.
 * @param userId - Current user whose per-user subtree to read; undefined pre-auth.
 * @returns The spaces, the user's open tabs, and the users map.
 */
function readMetaState(
  doc: Y.Doc,
  userId: string | undefined,
): {
  spaces: ReadonlyArray<ProjectSpace>;
  openTabIds: ReadonlyArray<string>;
  users: ReadonlyMap<string, ProjectUser>;
} {
  const spaces = readSpaces(doc);
  const users = readUsers(doc);
  if (!userId) {
    // Pre-auth fallback: open every space.
    return { spaces, openTabIds: spaces.map((s) => s.id), users };
  }
  const perUser = doc.getMap<Y.Map<unknown>>(PER_USER_KEY);
  const userMap = perUser.get(userId);
  if (!userMap) {
    // First time this user sees the project — show ALL existing
    // spaces in the tab bar so the workspace surfaces everything the
    // user can act on. The previous `[spaces[0].id]` shape collapsed
    // the bar to one tab and the chosen tab was unstable across
    // Y.Map.forEach iteration order, so creating a new Space made
    // the original Space silently disappear (Q6). The `openSpaceTab`
    // snapshot persists this state to the perUser subtree the moment
    // the user clicks anything.
    return { spaces, openTabIds: spaces.map((s) => s.id), users };
  }
  const openTabIdsArr = userMap.get(OPEN_TAB_IDS_KEY) as
    | Y.Array<string>
    | undefined;
  const openTabIds = openTabIdsArr ? openTabIdsArr.toArray() : [];
  return { spaces, openTabIds, users };
}
