// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * ## Presence is asserted, never denied
 *
 * Two things write "online": a connection arriving, and a heartbeat. NOTHING
 * writes "offline" when a socket closes, and that is the design rather than an
 * oversight. A disconnect is one SOCKET ending, while a record is keyed on the
 * PERSON — and the machine losing that socket cannot see whether they still
 * hold one somewhere else. So absence is never announced; it is inferred, by
 * {@link sweepStalePresence}, from nobody anywhere refreshing the timestamp.
 *
 * That inference is right across every instance without any of them
 * coordinating, because the record lives in the shared meta document: whichever
 * machine holds the connection refreshes the stamp, and the refresh reaches all
 * of them. A stale stamp therefore means no machine in the cluster is holding
 * that person — which is exactly what "offline" should mean.
 *
 * It also makes a crashed server need no special handling. The records it left
 * claiming to be online simply stop being refreshed, and the first person to
 * arrive afterwards starts the sweeps that clear them. The threshold is a
 * DELAY before that happens, not a chance to miss it.
 *
 * ## Every heartbeat is written, and there are only heartbeats
 *
 * The meta document's AWARENESS channel carries one thing: the clock renewal.
 * Carets live in the canvas and document files, never here (see the package's
 * CLAUDE.md — publishing a caret onto a meta document is a bug), so there is no
 * burst of cursor traffic to rate-limit and no reason to skip a beat. Each one
 * moves the timestamp, and the widest gap between two writes is therefore
 * exactly the widest gap between two heartbeats. The meta doc's SOCKET does
 * carry more — the Space and tab RPCs ride it as stateless messages — but those
 * reach a different hook and never touch presence.
 */

import type { Doc as YDoc, Map as YMap } from "yjs";
import * as Y from "yjs";

/** Yjs root holding the per-user presence records. */
const USERS_KEY = "users";

/** One user's presence, as stored in the meta document. */
export interface PresenceEntry {
  id: string;
  online: boolean;
  lastSeenAt: number;
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
 * @param args.document - The meta document to write into.
 * @param args.userId - The authenticated user.
 * @param args.now - Current time in ms.
 */
export function markOnline(args: {
  document: YDoc;
  userId: string;
  now: number;
}): void {
  const users = args.document.getMap(USERS_KEY);
  args.document.transact(() => {
    const existing = users.get(args.userId);
    const entry: YMap<unknown> =
      existing instanceof Y.Map ? existing : new Y.Map<unknown>();
    // Attached BEFORE anything is written or read. A Y.Map that is not yet in
    // a document keeps writes in a holding area its own `keys()` cannot see,
    // and yjs answers the read with an unconditional warning that goes to
    // stderr outside our logger, worded like data corruption and carrying no
    // document or user to trace it to. Measured: 11 of them in one run of this
    // module's tests.
    if (!(existing instanceof Y.Map)) users.set(args.userId, entry);
    entry.set("id", args.userId);
    entry.set("online", true);
    entry.set("lastSeenAt", args.now);
    // Anything else on this record is from a version that put more here, and
    // it is not merely untidy: a name written months ago outlives every rename
    // since, and the reason this record holds no name is that a copy cannot be
    // kept true. Measured in dev, records still carried `name` and `avatarUrl`
    // from before #1886, because writing three fields onto an existing map
    // leaves the rest of it exactly where it was.
    for (const key of [...entry.keys()]) {
      if (key !== "id" && key !== "online" && key !== "lastSeenAt") {
        entry.delete(key);
      }
    }
  });
}

/**
 * Record a heartbeat: push the timestamp forward, and assert that this person
 * is here.
 *
 * It puts an offline record BACK online, which it used to refuse. The refusal
 * was aimed at a late heartbeat resurrecting somebody who had just left, and
 * that danger went away when the socket close stopped writing "offline" at all.
 * What remains is the opposite risk: the sweep runs continuously and can flip
 * somebody who is still connected — a backgrounded browser tab has its timers
 * throttled and drifts toward the threshold — and without this, that record
 * could never recover. A wrongly revived record is corrected by the next sweep;
 * a wrongly offline one would be permanent.
 *
 * The one thing it still refuses is CREATING a record. A heartbeat is not an
 * arrival; only an authenticated connection is, and that goes through
 * {@link markOnline}.
 * @param args - Whose heartbeat, and when.
 * @param args.document - The meta document to write into.
 * @param args.userId - The user whose connection this heartbeat came from.
 * @param args.now - Current time in ms.
 * @returns True when the record was written, false when there is none to write.
 */
export function touchLastSeen(args: {
  document: YDoc;
  userId: string;
  now: number;
}): boolean {
  const users = args.document.getMap(USERS_KEY);
  const existing = users.get(args.userId);
  if (!(existing instanceof Y.Map)) return false;

  args.document.transact(() => {
    existing.set("online", true);
    existing.set("lastSeenAt", args.now);
  });
  return true;
}

/**
 * Turn off every record nobody is refreshing any more.
 *
 * This is the ONLY thing that writes "offline", and the timestamp is the only
 * evidence it uses. That sounds weaker than asking the server who it is holding
 * a connection for, and it is in fact stronger: a server only knows about its
 * OWN sockets, while this stamp is refreshed by whichever machine in the cluster
 * holds the connection and reaches all of them through the shared document. A
 * stamp nobody has touched therefore means nobody anywhere is holding them.
 *
 * The threshold has to clear the widest real gap between two heartbeats. That
 * is not the awake rate: a browser throttles a hidden tab's timers to once a minute
 * (Chrome, after five minutes hidden), while the socket stays open because the
 * keepalive pong never runs JavaScript. So a connected person can legitimately
 * look a minute stale, and a threshold at 60s would flip them on every cycle —
 * offline, then back on their next beat, once a minute forever.
 *
 * Records that already say offline are left alone: their timestamp is when they
 * were last actually heard from, and rewriting it on every pass would push
 * "last seen" forward for somebody long gone.
 * @param args - Which document, when, and how old counts as stale.
 * @param args.document - The meta document to sweep.
 * @param args.now - Current time in ms.
 * @param args.staleAfterMs - How long without a heartbeat before an online record is disbelieved.
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
