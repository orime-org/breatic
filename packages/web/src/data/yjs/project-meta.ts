// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as React from 'react';
import * as Y from 'yjs';

import { FOLLOWING_TABLE, agentPresenceRecordSchema, followingEntrySchema, parseAgentPresenceKey, type FollowingEntry, type SpaceType } from '@breatic/shared';
import { docName, getDoc } from '@web/data/yjs/manager';
import { useSocket, type ConnectionStatus } from '@web/data/yjs/use-socket';

/**
 * Project meta Yjs document — single source of truth for the project's
 * spaces list.
 *
 * Y.Doc structure:
 *
 *   spaces:    Y.Map<spaceId, Y.Map<{ id, name, type, locked?, claimToken? }>>
 *   users:     Y.Map<userId, Y.Map<{ id, online, lastSeenAt }>>
 *   following: Y.Map<socketId, Y.Map<{ userId, target, at, lastSeenAt }>>
 *
 * The tab bar is NOT in this doc: which Spaces are open, in what order, and
 * which one is showing belong to the person looking, not to the project. The
 * browser keeps them per account and project (`lib/project-tabs-storage.ts`,
 * user 2026-09-16) and `ProjectPage` holds them in a reducer
 * (`pages/project/tab-state.ts`). Old documents may still carry a `perUser`
 * key; nothing reads or writes it.
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

/**
 * One external agent's presence (#1488 design 19.2), read from its record
 * beside its owner's in `meta.users`. Only collab writes it.
 */
export interface ProjectAgent {
  ownerId: string;
  connectionId: string;
  online: boolean;
  /** No call for a while: no highlight, still listed. */
  idle: boolean;
  lastSeenAt: number;
  /** The Space it last named; null before any. */
  spaceId: string | null;
  /** The nodes or blocks it last named; empty before any. */
  focus: readonly string[];
  /** When it last named them, in ms; null before any. */
  focusAt: number | null;
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
  /** External agents that have acted in this project, online or not. */
  agents: ReadonlyArray<ProjectAgent>;
  /**
   * Whom each member follows (#920): user id → the user id they follow, from
   * the table collab keeps per connection. A tab's own awareness `following`
   * is only its declaration to the server; peers read this instead, because
   * awareness drops a hidden tab on the browser's throttled timers while its
   * connection, and so its entry, is still alive.
   */
  following: ReadonlyMap<string, string>;
  /** True once the initial Hocuspocus sync for this project has completed. */
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
 * the browser keeps it per account and project (see the module doc).
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

  const [state, setState] = React.useState<MetaProjection>(() => readMetaState(doc));

  React.useEffect(() => {
    /**
     * Re-read the spaces, users and following maps from the doc into React state.
     * @returns Nothing.
     */
    const update = (): void =>
      setState((previous) => {
        const next = readMetaState(doc);
        // Members' presence refreshes often; the agents list keeps its identity
        // until an agent's own record changes, so the Spaces drawing it do not redraw.
        return sameAgents(previous.agents, next.agents) ? { ...next, agents: previous.agents } : next;
      });
    // SPACES is a Y.Map keyed by spaceId on the collab side (see
    // `packages/collab/src/space-rpc.ts` + `auth.ts` +
    // `core/src/db/yjs-bootstrap.ts`). Client must observe the same
    // root collection or Yjs treats `getArray("spaces")` and
    // `getMap("spaces")` as separate, ghost roots and sync silently
    // never lands changes here — see PR-b post-merge bug.
    const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
    const users = doc.getMap<Y.Map<unknown>>(USERS_KEY);
    const following = doc.getMap(FOLLOWING_TABLE);
    spacesMap.observeDeep(update);
    users.observeDeep(update);
    following.observeDeep(update);
    update();
    return () => {
      spacesMap.unobserveDeep(update);
      users.unobserveDeep(update);
      following.unobserveDeep(update);
    };
  }, [doc]);

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
    if (!(m instanceof Y.Map) || parseAgentPresenceKey(userId) !== null) return;
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
 * Read the external agents' records out of `meta.users`.
 * @param doc - The project meta Y.Doc to read from.
 * @returns Every agent record that has the shape collab writes.
 */
function readAgents(doc: Y.Doc): ReadonlyArray<ProjectAgent> {
  const out: ProjectAgent[] = [];
  doc.getMap(USERS_KEY).forEach((value, key) => {
    const ids = parseAgentPresenceKey(key);
    if (ids === null || !(value instanceof Y.Map)) return;
    const parsed = agentPresenceRecordSchema.safeParse(value.toJSON());
    if (!parsed.success) return;
    const { online, idle, lastSeenAt, agent } = parsed.data;
    out.push({ ownerId: ids.userId, connectionId: ids.connectionId, online, idle: idle === true, lastSeenAt, spaceId: agent.spaceId, focus: agent.focus, focusAt: agent.focusAt });
  });
  return out;
}

/**
 * Whether two agents lists say the same.
 * @param a - One list.
 * @param b - The other.
 * @returns True when every record matches in order.
 */
function sameAgents(a: ReadonlyArray<ProjectAgent>, b: ReadonlyArray<ProjectAgent>): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Read whom each member follows from the server's following table.
 * @param doc - The project meta Y.Doc to read from.
 * @returns User id → whom they follow; a member following from several tabs
 *   counts the one that started latest (`lastSeenAt` only says a connection
 *   is alive), and an entry that fails the schema counts as absent.
 */
function readFollowingTable(doc: Y.Doc): ReadonlyMap<string, string> {
  const latest = new Map<string, FollowingEntry>();
  doc.getMap(FOLLOWING_TABLE).forEach((value) => {
    if (!(value instanceof Y.Map)) return;
    const parsed = followingEntrySchema.safeParse(value.toJSON());
    if (!parsed.success) return;
    const best = latest.get(parsed.data.userId);
    if (best === undefined || parsed.data.at > best.at) latest.set(parsed.data.userId, parsed.data);
  });
  return new Map([...latest].map(([userId, entry]) => [userId, entry.target]));
}

/** What `useProjectMeta` reads out of the meta doc itself. */
type MetaProjection = Pick<ProjectMetaState, 'spaces' | 'users' | 'agents' | 'following'>;

/**
 * Project the meta doc into the React-facing state shape.
 * @param doc - The project meta Y.Doc to read from.
 * @returns The spaces, the users map and whom each member follows.
 */
function readMetaState(doc: Y.Doc): MetaProjection {
  return { spaces: readSpaces(doc), users: readUsers(doc), agents: readAgents(doc), following: readFollowingTable(doc) };
}

/**
 * The project's Spaces, read from the project meta document the project page
 * already holds; this acquires no connection of its own.
 * @param projectId - The project.
 * @returns The Spaces, kept current.
 */
export function useProjectSpaceList(projectId: string): ReadonlyArray<ProjectSpace> {
  const doc = React.useMemo(() => getDoc(docName.projectMeta(projectId)), [projectId]);
  const [spaces, setSpaces] = React.useState<ReadonlyArray<ProjectSpace>>(() => readSpaces(doc));
  React.useEffect(() => {
    const spacesMap = doc.getMap<Y.Map<unknown>>(SPACES_KEY);
    /**
     * Re-read the Spaces after any change to them.
     * @returns Nothing.
     */
    const update = (): void => setSpaces(readSpaces(doc));
    spacesMap.observeDeep(update);
    update();
    return () => spacesMap.unobserveDeep(update);
  }, [doc]);
  return spaces;
}
