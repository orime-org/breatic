// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import * as Y from 'yjs';

import { dedupeTabOrder, sortSpaceIdsForTabOrder } from '@breatic/shared';

import type { SpaceType } from '@web/spaces';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket, type ConnectionStatus } from '@web/data/yjs/use-socket';

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
 * `Y.Map<userId, { id, online, lastSeenAt }>` — who has been in this project
 * and who is here now.
 *
 * Written only by the server, from the credential each connection presented
 * (#1886). It used to hold a name and an avatar too, projected from what the
 * browser announced about itself; both are gone. Those belong to the account,
 * and a copy here went stale the moment somebody renamed themselves — which
 * is what everyone else then saw on their carets.
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
  /**
   * Epoch milliseconds from the Space entry. Absent on entries written
   * before the field existed, which makes them older than every
   * timestamped one. It orders the tab bar a user has not arranged yet,
   * and both sides sort by it so the browser and collab agree.
   */
  createdAt?: number;
}

/**
 * Live user record stored in `meta.users[userId]`.
 *
 * Written only by the server, from the credential a connection presented
 * (#1886). It carries no name and no avatar: those belong to the account and
 * are read from the project roster, so a copy here would be a second truth
 * that goes stale the moment somebody renames themselves.
 */
export interface ProjectUser {
  id: string;
  /** Whether the server is currently holding a connection for this user. */
  online: boolean;
  /**
   * When this user was last heard from, in ms. Tracks the heartbeat rather
   * than the moment they connected, so it stays meaningful for somebody who
   * has been sitting here for days. Optional because records seeded before
   * this field existed have none; treat missing as "unknown".
   */
  lastSeenAt?: number;
}

export interface ProjectMetaState {
  spaces: ReadonlyArray<ProjectSpace>;
  /** Spaces the current user has open in their tab bar. */
  openTabIds: ReadonlyArray<string>;
  /**
   * Live map of `userId → { id, online, lastSeenAt }` for everyone who has
   * connected to this project. Map shape rather than array, because callsites
   * look up by id far more often than they iterate. Display names are not
   * here — resolve them from the project roster by id.
   */
  users: ReadonlyMap<string, ProjectUser>;
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

  // Who is online is read off `users` by whoever needs it. There used to be a
  // second field here holding the online ids as a set, derived from that same
  // map — one truth exposed twice, which read as two sources of presence. It
  // was added in May for a presence UI that was never built, and its one real
  // consumer works directly off `users` (#1886).
  return {
    ...state,
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
    const createdAt = m.get('createdAt');
    out.push({
      id: String(m.get('id') ?? ''),
      name: String(m.get('name') ?? ''),
      type: (m.get('type') as SpaceType) ?? 'canvas',
      locked: Boolean(m.get('locked') ?? false),
      claimToken: (m.get('claimToken') as string | undefined) ?? undefined,
      createdAt: typeof createdAt === 'number' ? createdAt : undefined,
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
      online: m.get('online') === true,
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
  // Every path that has no stored list shows the same order, and it is the
  // one collab seeds the first time this user touches a tab. Reading it off
  // `spaces` would be Y.Map iteration order, which two replicas can disagree
  // on — the untouched tabs would jump the first time anyone moved one.
  const defaultOrder = sortSpaceIdsForTabOrder(spaces);
  if (!userId) {
    // Pre-auth fallback: open every space.
    return { spaces, openTabIds: defaultOrder, users };
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
    return { spaces, openTabIds: defaultOrder, users };
  }
  const openTabIdsArr = userMap.get(OPEN_TAB_IDS_KEY) as
    | Y.Array<string>
    | undefined;
  // A stored list can hold an id twice: a Y.Array move is a delete plus an
  // insert, so two collab instances that had not synced can each move the
  // same tab. Both replicas agree on the merged array, so deduping it the
  // same way on both leaves them showing the same bar.
  const openTabIds = openTabIdsArr
    ? dedupeTabOrder(openTabIdsArr.toArray())
    : [];
  return { spaces, openTabIds, users };
}
