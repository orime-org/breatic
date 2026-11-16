// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who is in this project, decided by the server alone (#1886).
 *
 * The browser used to announce its own user id and the server projected that
 * into the roster. Now the server takes the id from the credential it already
 * validated at the handshake, so nothing here reads anything a client sent.
 *
 * ## Presence is asserted, never denied
 *
 * Only two things put a record in the "online" state: a connection arriving,
 * and a heartbeat. NOTHING writes "offline" on a disconnect, and that is the
 * whole design rather than an omission. A disconnect is one socket closing,
 * while a presence record is keyed on the PERSON — and one machine cannot see
 * whether that person still holds a socket somewhere else. So absence is not
 * announced by whoever happened to lose a socket; it is inferred from nobody,
 * anywhere, refreshing the timestamp.
 *
 * That inference is correct across every instance without any of them talking
 * to each other, because the record lives in the shared meta document: whoever
 * holds the connection refreshes the stamp, and the refresh reaches everyone.
 * A stale stamp therefore means no machine in the cluster is holding them.
 *
 * ## Why the heartbeat may put someone BACK online
 *
 * It used to refuse, to stop a late heartbeat resurrecting somebody who had
 * just left. With the sweep running continuously, refusing is the dangerous
 * half: a record wrongly flipped offline could never recover, while a wrongly
 * revived one is corrected by the next sweep. One error is permanent, the
 * other is bounded — so the heartbeat wins, and staying gone is left to the
 * absence of heartbeats.
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  markOnline,
  touchLastSeen,
  sweepStalePresence,
  readPresence,
  writeFollowing,
  deleteFollowing,
  touchFollowing,
  readFollowing,
} from "@collab/hooks/presence";

const ALICE = "u-alice";
const BOB = "u-bob";

/** A meta doc with nothing in it yet. */
function emptyMetaDoc(): Y.Doc {
  return new Y.Doc();
}

describe("presence — the server records who is here", () => {
  it("records a user as online when their connection is established", () => {
    const doc = emptyMetaDoc();

    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    expect(readPresence(doc, ALICE)).toEqual({
      id: ALICE,
      online: true,
      lastSeenAt: 1_000,
    });
  });

  it("keeps nothing but the id, the online flag and the timestamp", () => {
    // A name or an avatar here would be a second copy of something the account
    // owns, and a copy goes stale the moment its owner renames themselves.
    const doc = emptyMetaDoc();

    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    const entry = doc.getMap("users").get(ALICE) as Y.Map<unknown>;
    expect([...entry.keys()].sort()).toEqual(["id", "lastSeenAt", "online"]);
  });

  it("never reads a record before it is attached to the document", () => {
    // A Y.Map that is not yet in a document holds writes somewhere its own
    // `keys()` cannot see, and yjs answers that read with an unconditional
    // warning — straight to stderr, outside our logger, worded like data
    // corruption and naming neither the document nor the user. It fired once
    // per first-ever presence record, which is every member's first visit to
    // every project, and 11 times in one run of this file.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      markOnline({ document: emptyMetaDoc(), userId: ALICE, now: 1_000 });
      const complaints = warn.mock.calls
        .map((c) => c.join(" "))
        .filter((m) => m.includes("Invalid access"));
      expect(complaints).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("strips fields an older version left on the record", () => {
    // Writing three fields onto an existing map leaves everything else alone,
    // so a record made before #1886 kept its name and avatar for good. Measured
    // in dev: every record in a real project still carried both. A name that
    // outlives every rename since is the exact bug this record shape removes,
    // so arriving has to clear it rather than write around it.
    const doc = emptyMetaDoc();
    doc.transact(() => {
      const legacy = new Y.Map<unknown>();
      legacy.set("id", ALICE);
      legacy.set("online", false);
      legacy.set("lastSeenAt", 1);
      legacy.set("name", "A name from months ago");
      legacy.set("avatarUrl", "https://example.test/old.png");
      doc.getMap("users").set(ALICE, legacy);
    });

    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    const entry = doc.getMap("users").get(ALICE) as Y.Map<unknown>;
    expect([...entry.keys()].sort()).toEqual(["id", "lastSeenAt", "online"]);
    expect(readPresence(doc, ALICE)).toEqual({
      id: ALICE,
      online: true,
      lastSeenAt: 1_000,
    });
  });
});

describe("presence — the timestamp tracks the socket's signs of life", () => {
  it("moves the timestamp forward on every refresh", () => {
    // Every one of them, with nothing skipped. A socket has exactly one meta
    // connection, so one refresh is one write, and the per-socket table has
    // already throttled the socket's signs of life; the widest gap between
    // two writes is about the transport's ping period. A skip here would
    // silently widen that gap past what the threshold is sized for.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    expect(touchLastSeen({ document: doc, userId: ALICE, heardAt: 1_001 })).toBe(
      true,
    );
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(1_001);

    expect(touchLastSeen({ document: doc, userId: ALICE, heardAt: 1_002 })).toBe(
      true,
    );
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(1_002);
  });

  it("keeps the later timestamp when another socket's refresh was heard earlier", () => {
    // One user often holds several sockets, one per browser tab. A refresh
    // held back on one socket can run after another socket has already
    // written a later time; "last seen" must not move back.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 100 });

    expect(touchLastSeen({ document: doc, userId: ALICE, heardAt: 110 })).toBe(true);
    expect(touchLastSeen({ document: doc, userId: ALICE, heardAt: 100 })).toBe(true);

    expect(readPresence(doc, ALICE)).toEqual({ id: ALICE, online: true, lastSeenAt: 110 });
  });

  it("puts a user back online on their next sign of life", () => {
    // The sweep runs constantly, so it can flip somebody who is still here —
    // a pong delayed past the threshold by a slow network is enough. The next
    // one is proof they are connected, and proof outranks the inference that
    // flipped them.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });
    sweepStalePresence({ document: doc, now: 500_000, staleAfterMs: 90_000 });
    expect(readPresence(doc, ALICE)?.online).toBe(false);

    const wrote = touchLastSeen({
      document: doc,
      userId: ALICE,
      heardAt: 500_100,
    });

    expect(wrote).toBe(true);
    expect(readPresence(doc, ALICE)).toEqual({
      id: ALICE,
      online: true,
      lastSeenAt: 500_100,
    });
  });

  it("does not create an entry for someone who was never here", () => {
    // A heartbeat is not an arrival. Only an authenticated connection is, and
    // that goes through `markOnline`.
    const doc = emptyMetaDoc();

    const wrote = touchLastSeen({ document: doc, userId: ALICE, heardAt: 1_000 });

    expect(wrote).toBe(false);
    expect(readPresence(doc, ALICE)).toBeNull();
  });
});

describe("presence — records nobody is refreshing any more", () => {
  it("flips a record that claims to be online but stopped beating long ago", () => {
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 1_000 + 90_001,
      staleAfterMs: 90_000,
    });

    expect(swept).toEqual([ALICE]);
    expect(readPresence(doc, ALICE)?.online).toBe(false);
  });

  it("leaves a user whose heartbeat is still arriving alone", () => {
    // The only evidence that matters. Whoever holds their connection — this
    // machine or another one — is refreshing this stamp, and the refresh
    // reaches every instance through the shared document.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 1_000 + 89_999,
      staleAfterMs: 90_000,
    });

    expect(swept).toEqual([]);
    expect(readPresence(doc, ALICE)?.online).toBe(true);
  });

  it("does not touch records that already say offline", () => {
    // Their timestamp is when they were last actually heard from. Rewriting it
    // on every sweep would keep pushing "last seen" forward for someone gone.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });
    sweepStalePresence({ document: doc, now: 200_000, staleAfterMs: 90_000 });
    const afterFirst = readPresence(doc, ALICE);

    const swept = sweepStalePresence({
      document: doc,
      now: 900_000,
      staleAfterMs: 90_000,
    });

    expect(swept).toEqual([]);
    expect(readPresence(doc, ALICE)).toEqual(afterFirst);
  });

  it("sweeps the stale one and leaves the fresh one in the same pass", () => {
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });
    markOnline({ document: doc, userId: BOB, now: 500_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 500_000,
      staleAfterMs: 90_000,
    });

    expect(swept).toEqual([ALICE]);
    expect(readPresence(doc, ALICE)?.online).toBe(false);
    expect(readPresence(doc, BOB)?.online).toBe(true);
  });

  it("sweeps every stale record in one pass, not just the first", () => {
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });
    markOnline({ document: doc, userId: BOB, now: 2_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 500_000,
      staleAfterMs: 90_000,
    });

    expect(swept.sort()).toEqual([ALICE, BOB].sort());
    expect(readPresence(doc, ALICE)?.online).toBe(false);
    expect(readPresence(doc, BOB)?.online).toBe(false);
  });
});

/*
 * Whom each connection follows (#920, design 4.2.1), kept by the server in the
 * meta document's `following` root, keyed by socket id, one nested Y.Map per
 * entry like the `users` records. Expected from `hooks/presence.ts`:
 *
 *   writeFollowing({ document, socketId, userId, target, at, now }): boolean
 *     Writes `{ userId, target, at, lastSeenAt: now }` when the socket has no
 *     entry or its userId, target or at differ; otherwise writes nothing (no
 *     Yjs update). Returns whether it wrote.
 *   deleteFollowing({ document, socketId }): boolean
 *     Removes that socket's entry. Returns whether there was one.
 *   touchFollowing({ document, socketId, heardAt }): boolean
 *     Moves that socket's `lastSeenAt` forward to `heardAt` (never back).
 *     Creates nothing; returns whether there was an entry.
 *   readFollowing(document, socketId): { userId, target, at, lastSeenAt } | null
 *   sweepStalePresence(...) also deletes every following entry whose
 *     `lastSeenAt` is `staleAfterMs` or more behind `now`.
 */

const SOCK_A = "sock-a";
const SOCK_B = "sock-b";

/**
 * Count the Yjs updates a document emits while `fn` runs.
 * @param doc - The document to watch.
 * @param fn - What to run.
 * @returns How many updates it emitted.
 */
function updatesDuring(doc: Y.Doc, fn: () => void): number {
  let count = 0;
  const onUpdate = (): void => {
    count += 1;
  };
  doc.on("update", onUpdate);
  try {
    fn();
  } finally {
    doc.off("update", onUpdate);
  }
  return count;
}

describe("following — what each connection follows", () => {
  it("records whom a connection follows, with the time the client gave and now as last seen", () => {
    const doc = emptyMetaDoc();

    const wrote = writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });

    expect(wrote).toBe(true);
    expect(readFollowing(doc, SOCK_A)).toEqual({ userId: ALICE, target: BOB, at: 500, lastSeenAt: 1_000 });
  });

  it("keeps each entry as a nested map under the socket id, like the users records", () => {
    const doc = emptyMetaDoc();

    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });

    const entry = doc.getMap("following").get(SOCK_A);
    expect(entry).toBeInstanceOf(Y.Map);
    expect((entry as Y.Map<unknown>).toJSON()).toEqual({ userId: ALICE, target: BOB, at: 500, lastSeenAt: 1_000 });
  });

  it("writes nothing when the same declaration arrives again", () => {
    // Every awareness beat and every focus change resends the whole state;
    // rewriting the entry each time would broadcast a meta update per beat.
    const doc = emptyMetaDoc();
    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });

    let wrote = true;
    const updates = updatesDuring(doc, () => {
      wrote = writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 9_000 });
    });

    expect(wrote).toBe(false);
    expect(updates).toBe(0);
    expect(readFollowing(doc, SOCK_A)?.lastSeenAt).toBe(1_000);
  });

  it("rewrites the entry when the target or the start time changes", () => {
    const doc = emptyMetaDoc();
    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });

    expect(writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: "u-carol", at: 700, now: 2_000 })).toBe(true);
    expect(readFollowing(doc, SOCK_A)).toEqual({ userId: ALICE, target: "u-carol", at: 700, lastSeenAt: 2_000 });

    expect(writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: "u-carol", at: 800, now: 3_000 })).toBe(true);
    expect(readFollowing(doc, SOCK_A)).toEqual({ userId: ALICE, target: "u-carol", at: 800, lastSeenAt: 3_000 });
  });

  it("keeps one entry per connection, so two tabs of one user are two entries", () => {
    const doc = emptyMetaDoc();

    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });
    writeFollowing({ document: doc, socketId: SOCK_B, userId: ALICE, target: "u-carol", at: 600, now: 1_000 });

    expect(readFollowing(doc, SOCK_A)?.target).toBe(BOB);
    expect(readFollowing(doc, SOCK_B)?.target).toBe("u-carol");
  });

  it("deletes one connection's entry and leaves the others", () => {
    const doc = emptyMetaDoc();
    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });
    writeFollowing({ document: doc, socketId: SOCK_B, userId: BOB, target: ALICE, at: 500, now: 1_000 });

    expect(deleteFollowing({ document: doc, socketId: SOCK_A })).toBe(true);

    expect(readFollowing(doc, SOCK_A)).toBeNull();
    expect(readFollowing(doc, SOCK_B)?.target).toBe(ALICE);
    expect(deleteFollowing({ document: doc, socketId: SOCK_A })).toBe(false);
  });

  it("moves last seen forward on a sign of life, and never back", () => {
    const doc = emptyMetaDoc();
    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 500, now: 1_000 });

    expect(touchFollowing({ document: doc, socketId: SOCK_A, heardAt: 5_000 })).toBe(true);
    expect(readFollowing(doc, SOCK_A)).toEqual({ userId: ALICE, target: BOB, at: 500, lastSeenAt: 5_000 });

    touchFollowing({ document: doc, socketId: SOCK_A, heardAt: 4_000 });
    expect(readFollowing(doc, SOCK_A)?.lastSeenAt).toBe(5_000);
  });

  it("creates nothing for a socket that follows nobody", () => {
    const doc = emptyMetaDoc();

    expect(touchFollowing({ document: doc, socketId: SOCK_A, heardAt: 5_000 })).toBe(false);
    expect(doc.getMap("following").size).toBe(0);
  });

  it("is cleared by the stale sweep once nothing refreshes it, at the same threshold as presence", () => {
    // A crashed instance never runs the disconnect that would delete its
    // connections' entries; nobody refreshes them either.
    const doc = emptyMetaDoc();
    writeFollowing({ document: doc, socketId: SOCK_A, userId: ALICE, target: BOB, at: 1, now: 1_000 });
    writeFollowing({ document: doc, socketId: SOCK_B, userId: BOB, target: ALICE, at: 1, now: 1_002 });

    sweepStalePresence({ document: doc, now: 1_001 + 90_000, staleAfterMs: 90_000 });

    expect(readFollowing(doc, SOCK_A)).toBeNull();
    expect(readFollowing(doc, SOCK_B)?.target).toBe(ALICE);
  });
});
