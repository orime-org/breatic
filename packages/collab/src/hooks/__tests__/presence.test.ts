// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Who is in this project, decided by the server alone (#1886).
 *
 * The browser used to announce its own user id and the server projected that
 * into the roster. Now the server takes the id from the credential it already
 * validated at the handshake, so nothing here reads anything a client sent.
 *
 * Two failure modes drive most of these cases, and both were found by Gate 1
 * rather than by writing the happy path:
 *
 *   - A timestamp written once on connect stops moving. Someone connected for
 *     three days would carry a three-day-old stamp, and the staleness pass
 *     below would evict a person who never left. So the stamp tracks the
 *     heartbeat, throttled.
 *   - The heartbeat cannot cover the server process disappearing mid-session:
 *     nobody is left to write "offline". Such a record identifies itself — it
 *     claims to be online while its last heartbeat is long past — which is
 *     what the staleness pass looks for.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";

import {
  markOnline,
  markOffline,
  touchLastSeen,
  sweepStalePresence,
  readPresence,
  LAST_SEEN_THROTTLE_MS,
  __resetPresenceThrottle,
} from "@collab/hooks/presence";

const DOC = "project-p1/meta";
const ALICE = "u-alice";
const BOB = "u-bob";

/** A meta doc with nothing in it yet. */
function emptyMetaDoc(): Y.Doc {
  return new Y.Doc();
}

describe("presence — the server records who is here", () => {
  beforeEach(() => {
    __resetPresenceThrottle();
  });

  it("records a user as online when their connection is established", () => {
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });

    expect(readPresence(doc, ALICE)).toEqual({
      id: ALICE,
      online: true,
      lastSeenAt: 1_000,
    });
  });

  it("keeps nothing but the id, the online flag and the timestamp", () => {
    // Names and avatars have exactly one source of truth, the project roster.
    // A copy here is a copy that goes stale the moment somebody renames
    // themselves — the whole reason #1882 took them off the wire.
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });

    const entry = doc.getMap("users").get(ALICE) as Y.Map<unknown>;
    expect([...entry.keys()].sort()).toEqual(["id", "lastSeenAt", "online"]);
  });

  it("marks a user offline and moves their timestamp forward", () => {
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });
    markOffline({ document: doc, userId: ALICE, now: 5_000 });

    expect(readPresence(doc, ALICE)).toEqual({
      id: ALICE,
      online: false,
      lastSeenAt: 5_000,
    });
  });

  it("leaves other people alone when one of them goes offline", () => {
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });
    markOnline({ documentName: DOC, document: doc, userId: BOB, now: 1_000 });
    markOffline({ document: doc, userId: ALICE, now: 5_000 });

    expect(readPresence(doc, BOB)?.online).toBe(true);
  });
});

describe("presence — the timestamp tracks the heartbeat", () => {
  beforeEach(() => {
    __resetPresenceThrottle();
  });

  it("moves the timestamp forward once the throttle window has passed", () => {
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });

    const later = 1_000 + LAST_SEEN_THROTTLE_MS;
    const wrote = touchLastSeen({
      documentName: DOC,
      document: doc,
      userId: ALICE,
      now: later,
    });

    expect(wrote).toBe(true);
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(later);
  });

  it("writes at most once inside a throttle window", () => {
    // A connection heartbeats every 15s. Writing the doc on each one would
    // put a Yjs transaction on the wire per user per beat, for a number
    // nobody reads at that resolution.
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });

    const inWindow = 1_000 + LAST_SEEN_THROTTLE_MS - 1;
    const wrote = touchLastSeen({
      documentName: DOC,
      document: doc,
      userId: ALICE,
      now: inWindow,
    });

    expect(wrote).toBe(false);
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(1_000);
  });

  it("does not resurrect someone who is already marked offline", () => {
    // Heartbeats and disconnects race on reconnect. A late touch must not
    // put a departed user back on the list.
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });
    markOffline({ document: doc, userId: ALICE, now: 2_000 });

    touchLastSeen({
      documentName: DOC,
      document: doc,
      userId: ALICE,
      now: 2_000 + LAST_SEEN_THROTTLE_MS,
    });

    expect(readPresence(doc, ALICE)?.online).toBe(false);
  });

  it("does not create an entry for someone who was never here", () => {
    const doc = emptyMetaDoc();
    const wrote = touchLastSeen({
      documentName: DOC,
      document: doc,
      userId: ALICE,
      now: 1_000,
    });

    expect(wrote).toBe(false);
    expect(readPresence(doc, ALICE)).toBeNull();
  });
});

describe("presence — stale records left by a vanished server", () => {
  beforeEach(() => {
    __resetPresenceThrottle();
  });

  it("flips a record that claims to be online but stopped beating long ago", () => {
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 1_000 + 600_000,
      staleAfterMs: 300_000,
    });

    expect(swept).toEqual([ALICE]);
    expect(readPresence(doc, ALICE)?.online).toBe(false);
  });

  it("leaves a genuinely live user alone", () => {
    // The pass runs when a document loads, which happens while people are
    // connecting. Sweeping on "the server holds no connection for them yet"
    // would evict the very person who just triggered the load.
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 1_000 + 10_000,
      staleAfterMs: 300_000,
    });

    expect(swept).toEqual([]);
    expect(readPresence(doc, ALICE)?.online).toBe(true);
  });

  it("does not touch records that already say offline", () => {
    // Their timestamp is the moment they left. Rewriting it on every load
    // would keep pushing "last seen" forward for someone long gone.
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });
    markOffline({ document: doc, userId: ALICE, now: 2_000 });

    sweepStalePresence({
      document: doc,
      now: 2_000 + 600_000,
      staleAfterMs: 300_000,
    });

    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(2_000);
  });

  it("sweeps every stale record in one pass, not just the first", () => {
    const doc = emptyMetaDoc();
    markOnline({ documentName: DOC, document: doc, userId: ALICE, now: 1_000 });
    markOnline({ documentName: DOC, document: doc, userId: BOB, now: 1_000 });

    const swept = sweepStalePresence({
      document: doc,
      now: 1_000 + 600_000,
      staleAfterMs: 300_000,
    });

    expect(swept.sort()).toEqual([ALICE, BOB].sort());
  });
});
