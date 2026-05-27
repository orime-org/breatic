/**
 * `onAwarenessUpdate` handler — projects each client's Yjs awareness
 * state into `meta.users[userId]` (persistent Y.Map) so other peers
 * have a name + avatar to render even after the originator disconnects.
 *
 * Replaces the prior `users:upsert-self` stateless RPC path (PR #153)
 * which had to maintain a separate sentForProviderRef on the front-end
 * and missed re-firing on `currentUser` mutations (rename / avatar
 * change). Awareness is declarative: `setLocalStateField('user', ...)`
 * re-fires for any deps change, Yjs internally diffs + broadcasts only
 * on real value change.
 *
 * Three invariants this module enforces:
 *
 *   1. **Anti-spoof**: only the awareness state whose `user.id` matches
 *      the connection-context user is honored. A malicious client can
 *      `setLocalStateField('user', { id: 'someoneElse', name: 'fake' })`
 *      but that update fails the identity check and is ignored.
 *
 *   2. **Multi-instance dedup**: in a multi-collab-instance deployment
 *      `extension-redis` syncs awareness updates across instances. We
 *      only write when `context.user.id === state.user.id` — for
 *      remote-synced updates the triggering context is the remote
 *      peer's auth context (or empty), so the check naturally rejects
 *      duplicate writes on the receiving instance.
 *
 *   3. **Debounce**: cursor / selection / currentSpaceId updates would
 *      fire onAwarenessUpdate at sub-second rates. We diff the user
 *      fields and skip transact when only non-user fields changed.
 *      For `lastSeenAt` we keep a per-userId timestamp map and only
 *      transact a refresh when >= LAST_SEEN_DEBOUNCE_MS elapsed since
 *      the last write — keeps the bell from broadcasting a Yjs update
 *      every time the cursor moves.
 */

import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Document } from "@hocuspocus/server";

/**
 * Minimum time between `lastSeenAt` writes for a single user, in ms.
 * Cursor / selection awareness updates fire continuously while the
 * user moves the mouse; without this debounce we'd write meta.users
 * (and broadcast a Yjs update) dozens of times per second. 30s
 * resolution is more than enough for "online / last active N min ago"
 * UI surfaces.
 */
const LAST_SEEN_DEBOUNCE_MS = 30_000;

/**
 * Per-meta-doc bookkeeping for the debounce window. Key is
 * `${documentName}:${userId}`; value is `Date.now()` at last write.
 * Lives in module scope so it survives across hook invocations within
 * a single collab process. Multi-collab-instance dedup is handled by
 * the identity check, not by this map (each instance maintains its
 * own debounce timestamps for its locally-triggered writes).
 */
const lastSeenWriteAt = new Map<string, number>();

/**
 * Shape of the `user` field a client writes into awareness via
 * `provider.awareness.setLocalStateField('user', ...)`. Only these
 * fields are projected into `meta.users[userId]`. Other awareness
 * state (cursor, selection, currentSpaceId, etc.) is intentionally
 * NOT persisted — that's ephemeral presence and lives only in the
 * awareness instance.
 */
export interface AwarenessUserField {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Result of processing one awareness update. Surfaced to the caller
 * (hocuspocus.ts) for logging + telemetry; the hook itself doesn't
 * branch on this.
 */
export interface ProcessAwarenessResult {
  /** Updated meta.users[userId] entries (transact ran for these). */
  written: string[];
  /** State entries rejected because state.user.id !== context.user.id. */
  rejected: string[];
  /** Updates where only non-user fields changed; debounce window held. */
  skipped: string[];
}

/**
 * Parse a single awareness state into the `AwarenessUserField` shape.
 * Returns null if the state has no `user` object or the required
 * fields are missing / malformed — better to no-op than to write
 * partial garbage into meta.users.
 */
function readUserField(state: unknown): AwarenessUserField | null {
  if (!state || typeof state !== "object") return null;
  const userField = (state as { user?: unknown }).user;
  if (!userField || typeof userField !== "object") return null;
  const u = userField as Record<string, unknown>;
  if (typeof u.id !== "string" || u.id.length === 0) return null;
  if (typeof u.name !== "string" || u.name.length === 0) return null;
  const avatar =
    typeof u.avatarUrl === "string"
      ? u.avatarUrl
      : u.avatarUrl === null
        ? null
        : null;
  return { id: u.id, name: u.name, avatarUrl: avatar };
}

/**
 * Project awareness state changes into `meta.users[userId]` on the
 * given Y.Doc. Idempotent: skips the transact when nothing in the
 * persisted entry would change (and the debounce window hasn't
 * elapsed for the lastSeenAt refresh).
 *
 * Designed to be called from Hocuspocus's `onAwarenessUpdate` hook
 * with the hook's `added`/`updated` client ids + `awareness` instance
 * + `document` + `context`.
 */
export function projectAwarenessIntoMetaUsers(args: {
  documentName: string;
  document: Document;
  awareness: Awareness;
  added: number[];
  updated: number[];
  contextUserId: string | undefined;
  now: number;
}): ProcessAwarenessResult {
  const written: string[] = [];
  const rejected: string[] = [];
  const skipped: string[] = [];

  if (!args.contextUserId) {
    // No authenticated user on this context — refuse to write
    // anything. (Remote-synced updates from other collab instances
    // land here with an empty / system context; multi-instance dedup
    // depends on this rejection.)
    return { written, rejected, skipped };
  }

  const usersMap = args.document.getMap("users");
  const changedClientIds = new Set<number>([...args.added, ...args.updated]);

  for (const clientId of changedClientIds) {
    const state = args.awareness.getStates().get(clientId);
    const userField = readUserField(state);
    if (!userField) continue;

    // Anti-spoof + multi-instance dedup gate.
    if (userField.id !== args.contextUserId) {
      rejected.push(userField.id);
      continue;
    }

    const existing = usersMap.get(userField.id) as Y.Map<unknown> | undefined;
    const prevName =
      existing instanceof Y.Map ? existing.get("name") : undefined;
    const prevAvatar =
      existing instanceof Y.Map ? existing.get("avatarUrl") : undefined;
    const userFieldsChanged =
      prevName !== userField.name || prevAvatar !== userField.avatarUrl;

    const debounceKey = `${args.documentName}:${userField.id}`;
    const lastWriteAt = lastSeenWriteAt.get(debounceKey) ?? 0;
    const debounceElapsed = args.now - lastWriteAt >= LAST_SEEN_DEBOUNCE_MS;

    if (!userFieldsChanged && !debounceElapsed) {
      skipped.push(userField.id);
      continue;
    }

    args.document.transact(() => {
      const entry: Y.Map<unknown> =
        existing instanceof Y.Map ? existing : new Y.Map<unknown>();
      entry.set("id", userField.id);
      entry.set("name", userField.name);
      entry.set("avatarUrl", userField.avatarUrl);
      entry.set("lastSeenAt", args.now);
      if (!(existing instanceof Y.Map)) {
        usersMap.set(userField.id, entry);
      }
    });
    lastSeenWriteAt.set(debounceKey, args.now);
    written.push(userField.id);
  }

  return { written, rejected, skipped };
}

/** Test-only — reset the per-process debounce map between cases. */
export function __resetAwarenessDebounceState(): void {
  lastSeenWriteAt.clear();
}
