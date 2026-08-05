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
 *   spaces:  Y.Map<spaceId, Y.Map<{ id, name, type, locked?, claimToken? }>>
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
 *   - Which tabs someone had open survives a machine change, because
 *     Hocuspocus persists the Y.Doc to PG and the whole doc arrives on
 *     sync. Going through the server does not change that — the value
 *     still ends up in the same place, just written by the backend.
 *
 * Write boundaries — the client writes NOTHING in this document.
 *
 * Every change goes through a stateless RPC on the live meta-doc
 * WebSocket (`sendSpaceRpc` → collab `services/space-rpc.ts`): the Space
 * lifecycle as `space:*`, and each person's own tab bar as `tab:open` /
 * `tab:close`. Collab checks the role, makes the privileged write, and
 * Yjs broadcasts it back. The client's connection to this doc is
 * read-only at the framework level, so a direct write does not fail
 * loudly — it simply never lands.
 *
 * The tab bar used to be the one exception, written straight into
 * `perUser[userId]`. That exception is why the server needed a gate that
 * could tell which field an incoming frame touched, and a gate that has
 * to enumerate the framework's internal message types fails open on the
 * ones it misses. Removing the exception let the rule become flat and
 * the gate disappear (task #27).
 */

const SPACES_KEY = 'spaces';
const PER_USER_KEY = 'perUser';
const OPEN_TAB_IDS_KEY = 'openTabIds';
/**
 * Y.Map<userId, { name, avatarUrl }> seeded at project creation by the
 * meta bootstrap and kept live by collab's awareness projection
 * (`hooks/awareness-meta-users.ts`, which replaced the earlier
 * handshake-time upsert - PR #153). Consumers (ProjectActivityButton
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
  /**
   * The token this machine sent when it asked for this Space, echoed back
   * on the entry. Present only on Spaces created through `space:create`,
   * and only meaningful to the machine that generated it — that is how it
   * recognises the Space it asked for, since the server mints the id and
   * the requester never knew it in advance.
   */
  claimToken?: string;
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
   * ProjectActivityButton looks up `users[m.actor]?.name` to render
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
 * Which tab to activate after the project's spaces change, when the active
 * one has VANISHED (deleted locally or by a collaborator — no longer in
 * `liveSpaceIds`).
 *
 * ## It answers one question: has the active Space disappeared?
 *
 * It deliberately does NOT ask whether the active id is in `openTabIds`. An id
 * that is live but missing from that list has two opposite meanings that look
 * identical in the data: a tab that was just closed, and a Space that is being
 * opened right now, whose `tab:open` broadcast has not landed yet — the click
 * handler sets the active id immediately, because which tab is active is local
 * window state and switching stays instant (design §6.6.2). Reacting to that
 * shape throws the user back to the first tab the moment they pick a Space.
 * The closed case needs nothing from here either: `resolveEffectiveActiveSpace`
 * already falls back to the first open tab, and the tab strip highlights the
 * id that fallback returns, so both the body and the highlight follow.
 *
 * It used to also return the vanished ids for the caller to close. That is
 * the server's job now — deleting a Space clears it from everyone's list in
 * the same broadcast — and a client could not do it anyway, since it does not
 * write this document. Which tab is ACTIVE is local window state, never
 * shared, so nobody else can put it right for us; that is the half that
 * stays here. Pure — the caller applies the result.
 * @param openTabIds - This user's open-tab space ids.
 * @param liveSpaceIds - The set of space ids that still exist in the project.
 * @param activeSpaceId - This user's active space id (or null).
 * @returns The id to activate, `null` for the empty state, or `undefined` when
 *   the active space is still live and nothing should move.
 */
export function nextActiveAfterVanish(
  openTabIds: ReadonlyArray<string>,
  liveSpaceIds: ReadonlySet<string>,
  activeSpaceId: string | null,
): string | null | undefined {
  if (activeSpaceId === null || liveSpaceIds.has(activeSpaceId)) {
    return undefined;
  }
  return openTabIds.find((id) => liveSpaceIds.has(id)) ?? null;
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
      claimToken: (m.get('claimToken') as string | undefined) ?? undefined,
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
    // the original Space silently disappear (Q6). This is a read-time
    // default only; the server writes the same set into `perUser` the
    // first time the user opens or closes anything (`ensureOpenTabList`
    // in collab's space-rpc), so the two agree from then on.
    return { spaces, openTabIds: spaces.map((s) => s.id), users };
  }
  const openTabIdsArr = userMap.get(OPEN_TAB_IDS_KEY) as
    | Y.Array<string>
    | undefined;
  const openTabIds = openTabIdsArr ? openTabIdsArr.toArray() : [];
  return { spaces, openTabIds, users };
}
