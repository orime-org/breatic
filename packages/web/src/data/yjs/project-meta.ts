// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import * as Y from 'yjs';

import type { SpaceType } from '@breatic/shared';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket, type ConnectionStatus } from '@web/data/yjs/use-socket';

/**
 * Project meta Yjs document — single source of truth for the project's
 * spaces list.
 *
 * Y.Doc structure:
 *
 *   spaces:  Y.Map<spaceId, Y.Map<{ id, name, type, locked?, claimToken? }>>
 *
 * The tab bar is NOT in this doc and is not stored anywhere (user
 * 2026-09-12): which Spaces are open, in what order, and which one is
 * showing are all runtime state of one browser tab. Opening a project starts
 * from the newest Space every time, two windows on the same account each
 * keep their own bar, and closing the page forgets it. `ProjectPage` holds
 * it in a reducer (`pages/project/tab-state.ts`). Old documents may still
 * carry a `perUser` key; nothing reads or writes it.
 *
 * Write boundaries — the client writes NOTHING in this document.
 *
 * Every change goes through a stateless RPC on the live meta-doc WebSocket
 * (`sendSpaceRpc` → collab `services/space-rpc.ts`): the Space lifecycle as
 * `space:*`. Collab checks the role, makes the privileged write, and Yjs
 * broadcasts it back. The client's connection to this doc is read-only at
 * the framework level, so a direct write does not fail loudly — it simply
 * never lands.
 */

const SPACES_KEY = 'spaces';
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
  /**
   * Live map of `userId → { id, online, lastSeenAt }` for everyone who has
   * connected to this project. Map shape rather than array, because callsites
   * look up by id far more often than they iterate. Display names are not
   * here — resolve them from the project roster by id.
   */
  users: ReadonlyMap<string, ProjectUser>;
  /**
   * True once the initial Hocuspocus sync has completed AND the projection
   * above was read from the project you asked for. Both go false together
   * for the one render after a project switch.
   */
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
 * Subscribe to a project's meta document. Returns the live spaces list;
 * updates trigger re-renders. The tab bar is not part of this projection —
 * it is runtime state of one browser tab (see the module doc).
 * @param projectId - Project whose meta document to subscribe to.
 * @returns Live meta state: spaces, online users, provider, and connection status.
 */
export function useProjectMeta(projectId: string): ProjectMetaState {
  const doc = React.useMemo(
    () => getDoc(docName.projectMeta(projectId)),
    [projectId],
  );
  const { synced, provider, status, authFailedReason } = useSocket({
    name: docName.projectMeta(projectId),
    doc,
  });

  // The doc the state below was read from, carried alongside it. Switching
  // project changes `doc` during render but leaves this state holding the
  // previous project's content until the effect re-reads it, and `synced`
  // holding the previous project's answer until the socket effect re-runs.
  // Both are stale together for exactly that one render, and a reader that
  // takes the list as settled acts on the wrong project's Spaces — so
  // `synced` below says "this state came from the document you asked for".
  const [state, setState] = React.useState<{
    readDoc: Y.Doc;
    spaces: ReadonlyArray<ProjectSpace>;
    users: ReadonlyMap<string, ProjectUser>;
  }>(() => ({ readDoc: doc, ...readMetaState(doc) }));

  React.useEffect(() => {
    /**
     * Re-read the spaces and users maps from the doc into React state.
     * @returns Nothing.
     */
    const update = (): void =>
      setState({ readDoc: doc, ...readMetaState(doc) });
    // SPACES is a Y.Map keyed by spaceId on the collab side (see
    // `packages/collab/src/space-rpc.ts` + `auth.ts` +
    // `core/src/db/yjs-bootstrap.ts`). Client must observe the same
    // root collection or Yjs treats `getArray("spaces")` and
    // `getMap("spaces")` as separate, ghost roots and sync silently
    // never lands changes here — see PR-b post-merge bug.
    const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
    const users = doc.getMap<Y.Map<unknown>>(USERS_KEY);
    spacesMap.observeDeep(update);
    users.observeDeep(update);
    update();
    return () => {
      spacesMap.unobserveDeep(update);
      users.unobserveDeep(update);
    };
  }, [doc]);

  // Who is online is read off `users` by whoever needs it. There used to be a
  // second field here holding the online ids as a set, derived from that same
  // map — one truth exposed twice, which read as two sources of presence. It
  // was added in May for a presence UI that was never built, and its one real
  // consumer works directly off `users` (#1886).
  const { readDoc, ...projection } = state;
  return {
    ...projection,
    synced: synced && readDoc === doc,
    provider,
    status,
    authFailedReason,
  };
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
 * Project the meta doc into the React-facing state shape.
 * @param doc - The project meta Y.Doc to read from.
 * @returns The spaces and the users map.
 */
function readMetaState(doc: Y.Doc): {
  spaces: ReadonlyArray<ProjectSpace>;
  users: ReadonlyMap<string, ProjectUser>;
} {
  return { spaces: readSpaces(doc), users: readUsers(doc) };
}
