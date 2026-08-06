// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Who is currently in a project, written by the server alone (#1886).
 *
 * The user id comes from the credential this connection presented at the
 * handshake — `onAuthenticate` resolved it against the database and put it on
 * the connection context. Nothing in this module reads anything a client sent,
 * so there is no claim to verify and no way to claim somebody else.
 *
 * ## What a record holds, and what it deliberately does not
 *
 * Only `id`, `online` and `lastSeenAt`. A display name or an avatar here would
 * be a second copy of something the account already owns, and a copy goes stale
 * the moment its owner renames themselves — that is the bug #1882 set out to
 * remove, and putting either field back would bring it straight back.
 *
 * ## Why the timestamp has to keep moving
 *
 * `lastSeenAt` is what {@link sweepStalePresence} judges staleness by, so it
 * has to mean "last heard from", not "connected at". Stamped once on connect,
 * somebody online for three days would carry a three-day-old stamp and the
 * sweep would evict a person who never left. So it is refreshed while the
 * connection lives — throttled, because a connection heartbeats every 15
 * seconds and nobody reads this number at that resolution.
 *
 * ## Why a sweep is needed at all
 *
 * The WebSocket keepalive covers everything that happens to a *client*: the
 * server pings, and a client that stops answering has its connection closed,
 * which arrives here as an ordinary disconnect. What it cannot cover is the
 * server process itself going away mid-session — a deploy, a restart, a crash.
 * Nobody is left to write "offline", so the record sits there claiming to be
 * online. Such a record announces itself: online, with a last heartbeat far in
 * the past. That is exactly what the sweep looks for.
 */

import type { Doc as YDoc, Map as YMap } from "yjs";
import * as Y from "yjs";

/**
 * Minimum gap between two `lastSeenAt` writes for one user, in ms.
 *
 * Matches the window the previous awareness projection used, for the same
 * reason: heartbeats arrive far more often than this number is read.
 */
export const LAST_SEEN_THROTTLE_MS = 30_000;

/** Yjs root holding the per-user presence records. */
const USERS_KEY = "users";

/** One user's presence, as stored in the meta document. */
export interface PresenceEntry {
  id: string;
  online: boolean;
  lastSeenAt: number;
}

/**
 * Last time each user's timestamp was written, keyed by document and user.
 *
 * Per process, and deliberately not persisted: it only exists to skip writes,
 * so losing it on restart costs one extra write per user, nothing else.
 */
const lastWriteAt = new Map<string, number>();

/**
 * Build the throttle key for one user on one document.
 * @param documentName - Name of the meta document.
 * @param userId - The user being recorded.
 * @returns The composite key.
 */
function throttleKey(documentName: string, userId: string): string {
  return `${documentName}:${userId}`;
}

/**
 * Fetch a user's record, or null when they have never been recorded here.
 * @param document - The meta document.
 * @param userId - The user to look up.
 * @returns The stored presence, or null.
 */
export function readPresence(
  document: YDoc,
  userId: string,
): PresenceEntry | null {
  const entry = document.getMap(USERS_KEY).get(userId);
  if (!(entry instanceof Y.Map)) return null;
  const online = entry.get("online");
  const lastSeenAt = entry.get("lastSeenAt");
  if (typeof online !== "boolean" || typeof lastSeenAt !== "number") return null;
  return { id: userId, online, lastSeenAt };
}

/**
 * Record that a user is present, creating their record if this is their first
 * time in this project.
 *
 * Called when a connection has been authenticated, so the id is the one the
 * server resolved, never one a client offered.
 * @param args - What to record and when.
 * @param args.documentName - Meta document name; scopes the write throttle.
 * @param args.document - The meta document to write into.
 * @param args.userId - The authenticated user.
 * @param args.now - Current time in ms.
 */
export function markOnline(args: {
  documentName: string;
  document: YDoc;
  userId: string;
  now: number;
}): void {
  const users = args.document.getMap(USERS_KEY);
  args.document.transact(() => {
    const existing = users.get(args.userId);
    const entry: YMap<unknown> =
      existing instanceof Y.Map ? existing : new Y.Map<unknown>();
    entry.set("id", args.userId);
    entry.set("online", true);
    entry.set("lastSeenAt", args.now);
    if (!(existing instanceof Y.Map)) users.set(args.userId, entry);
  });
  lastWriteAt.set(throttleKey(args.documentName, args.userId), args.now);
}

/**
 * Record that a user has left.
 *
 * The caller decides when this is true: a user may hold several connections at
 * once (one socket carries several documents, and they may have several tabs),
 * so this belongs after the last of them has gone, not after any one of them.
 * @param args - Who left and when.
 * @param args.document - The meta document to write into.
 * @param args.userId - The user who left.
 * @param args.now - Current time in ms, recorded as when they were last seen.
 */
export function markOffline(args: {
  document: YDoc;
  userId: string;
  now: number;
}): void {
  const users = args.document.getMap(USERS_KEY);
  const existing = users.get(args.userId);
  if (!(existing instanceof Y.Map)) return;
  args.document.transact(() => {
    existing.set("online", false);
    existing.set("lastSeenAt", args.now);
  });
}

/**
 * Push a present user's timestamp forward, at most once per throttle window.
 *
 * Two things it refuses to do, both of which would be wrong rather than merely
 * wasteful: it will not create a record (a heartbeat is not an arrival), and it
 * will not touch someone already marked offline — a heartbeat and a disconnect
 * race on reconnect, and the late one must not put a departed user back.
 * @param args - Whose heartbeat, and when.
 * @param args.documentName - Meta document name; scopes the write throttle.
 * @param args.document - The meta document to write into.
 * @param args.userId - The user still connected.
 * @param args.now - Current time in ms.
 * @returns True when the timestamp was written, false when it was throttled or refused.
 */
export function touchLastSeen(args: {
  documentName: string;
  document: YDoc;
  userId: string;
  now: number;
}): boolean {
  const users = args.document.getMap(USERS_KEY);
  const existing = users.get(args.userId);
  if (!(existing instanceof Y.Map)) return false;
  if (existing.get("online") !== true) return false;

  const key = throttleKey(args.documentName, args.userId);
  const previous = lastWriteAt.get(key) ?? 0;
  if (args.now - previous < LAST_SEEN_THROTTLE_MS) return false;

  args.document.transact(() => {
    existing.set("lastSeenAt", args.now);
  });
  lastWriteAt.set(key, args.now);
  return true;
}

/**
 * Clear records that claim to be online but stopped beating long ago.
 *
 * Runs when a document loads, which is the moment after a server restart when
 * such records can exist and nothing else will correct them. Records that
 * already say offline are left untouched: their timestamp is when their owner
 * actually left, and rewriting it every load would keep pushing "last seen"
 * forward for somebody long gone.
 * @param args - Which document, when, and how old counts as stale.
 * @param args.document - The meta document to sweep.
 * @param args.now - Current time in ms.
 * @param args.staleAfterMs - How long without a heartbeat before an online record is disbelieved. Must be well above the keepalive interval, or a live user gets swept.
 * @returns The user ids that were flipped to offline.
 */
export function sweepStalePresence(args: {
  document: YDoc;
  now: number;
  staleAfterMs: number;
}): string[] {
  const users = args.document.getMap(USERS_KEY);
  const swept: string[] = [];

  args.document.transact(() => {
    users.forEach((value, userId) => {
      if (!(value instanceof Y.Map)) return;
      if (value.get("online") !== true) return;
      const lastSeenAt = value.get("lastSeenAt");
      if (typeof lastSeenAt !== "number") return;
      if (args.now - lastSeenAt < args.staleAfterMs) return;
      value.set("online", false);
      swept.push(userId);
    });
  });

  return swept;
}

/**
 * Test-only — drop the per-process throttle bookkeeping between cases.
 */
export function __resetPresenceThrottle(): void {
  lastWriteAt.clear();
}
