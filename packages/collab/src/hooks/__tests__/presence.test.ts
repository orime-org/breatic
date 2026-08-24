// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

describe("presence — the timestamp tracks the heartbeat", () => {
  it("moves the timestamp forward on every heartbeat", () => {
    // Every one of them, with nothing skipped. Nothing but these renewals
    // reaches the meta document's awareness channel — carets live in the
    // canvas and document files — so there is no burst to rate-limit, and the
    // widest gap between two writes is exactly the browser's beat interval. A
    // skip here would silently widen that gap past what the threshold is
    // sized for.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });

    expect(touchLastSeen({ document: doc, userId: ALICE, now: 1_001 })).toBe(
      true,
    );
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(1_001);

    expect(touchLastSeen({ document: doc, userId: ALICE, now: 1_002 })).toBe(
      true,
    );
    expect(readPresence(doc, ALICE)?.lastSeenAt).toBe(1_002);
  });

  it("puts a user back online when their heartbeat arrives", () => {
    // The sweep runs constantly, so it can flip somebody who is still here —
    // a backgrounded browser tab has its timers throttled to once a minute and
    // can drift close to the threshold. Their next heartbeat is proof they are
    // connected, and proof outranks the inference that flipped them.
    const doc = emptyMetaDoc();
    markOnline({ document: doc, userId: ALICE, now: 1_000 });
    sweepStalePresence({ document: doc, now: 500_000, staleAfterMs: 90_000 });
    expect(readPresence(doc, ALICE)?.online).toBe(false);

    const wrote = touchLastSeen({
      document: doc,
      userId: ALICE,
      now: 500_100,
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

    const wrote = touchLastSeen({ document: doc, userId: ALICE, now: 1_000 });

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
