// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The last thing that runs before a document leaves memory.
 *
 * Measured behaviour of hocuspocus 4.5.0 without it: the last client leaves,
 * no store is even attempted, the document is unloaded, and reopening it
 * after the database recovers shows an empty document. This hook is the one
 * place that can still act.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Y from "yjs";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@breatic/core", () => ({ createLogger: () => mockLogger }));

import { createUnloadGate } from "@collab/hooks/unload-gate.js";
import type { StoreFailureAlert } from "@collab/services/store-alert.js";
import {
  armTimedStore,
  commitStore,
  consumeTimedStoreArm,
  forgetDocument,
  hasUnsavedContent,
  noteDocumentChange,
  noteStoreOutcome,
  beginStore,
} from "@collab/services/store-tracker.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";

/** A document carrying some text. */
function documentWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return doc;
}

/**
 * Build a gate whose store either lands, fails, or never returns.
 * @param outcome - What the final attempt should do.
 * @returns The gate plus everything it did.
 */
function harness(outcome: "lands" | "fails" | "hangs" | "not-reached" = "lands") {
  const rescued: Array<{ documentName: string; state: Uint8Array }> = [];
  const deleted: string[] = [];
  const alerted: StoreFailureAlert[] = [];
  const storeCalls: string[] = [];

  const gate = createUnloadGate({
    instanceId: "inst-a",
    encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
    storeNow: async ({ name }) => {
      storeCalls.push(name);
      // The real path goes through hocuspocus into the persistence
      // extension, which consumes the arm and commits the counter. Stand in
      // for exactly that, so the gate is judged on the counter like in
      // production rather than on this stub's return value.
      // Exactly what an aborted hook chain looks like from out here: the
      // library resolves normally and our extension never ran, so the arm is
      // still sitting there untouched.
      if (outcome === "not-reached") return true;
      if (!consumeTimedStoreArm(name)) return true;
      // Our hook DID run — the arm above is spent — and then the write itself
      // never came back. That is what a hung database looks like, and it is a
      // different thing from the chain never reaching us.
      if (outcome === "hangs") return new Promise<boolean>(() => {});
      if (outcome === "fails") {
        noteStoreOutcome(name, "refused");
        return true;
      }
      commitStore(name, beginStore(name));
      noteStoreOutcome(name, "stored");
      return true;
    },
    writeRescue: async ({ documentName, state }) => {
      rescued.push({ documentName, state });
      return `/rescue/${rescued.length}.yjs`;
    },
    writeRescueNote: async () => {},
    alert: async (failure) => void alerted.push(failure),
  });

  return { gate, rescued, deleted, alerted, storeCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDocument(DOC);
});

describe("the unload gate — a document with nothing outstanding", () => {
  it("attempts no store and writes no rescue file", async () => {
    const { gate, storeCalls, rescued } = harness();

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(storeCalls).toHaveLength(0);
    expect(rescued).toHaveLength(0);
  });
});

describe("the unload gate — a document with outstanding content", () => {
  it("makes exactly one final attempt", async () => {
    const { gate, storeCalls } = harness();
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(storeCalls).toEqual([DOC]);
  });

  it("writes no rescue file and raises no alert when the attempt lands", async () => {
    const { gate, rescued, alerted } = harness("lands");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(rescued).toHaveLength(0);
    expect(alerted).toHaveLength(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("rescues the content, logs, and alerts when the attempt fails", async () => {
    const { gate, rescued, alerted } = harness("fails");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({
      documentName: DOC,
      document: documentWithText("content that must not vanish"),
    });

    expect(rescued).toHaveLength(1);
    const back = new Y.Doc();
    Y.applyUpdate(back, rescued[0]!.state);
    expect(back.getText("body").toString()).toBe("content that must not vanish");
    expect(alerted).toHaveLength(1);
    expect(alerted[0]?.rescuePath).toBe("/rescue/1.yjs");
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it("never throws, so the document is always released", async () => {
    // Throwing from this hook aborts the unload in hocuspocus, which would
    // strand the document in memory with zero connections.
    const { gate } = harness("fails");
    noteDocumentChange(DOC);

    await expect(
      gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") }),
    ).resolves.toBeUndefined();
  });

  it("does NOT clear the counters — the library may still keep the document", async () => {
    // hocuspocus re-checks shouldUnloadDocument after this hook returns
    // (server:1580) and abandons the unload when a connection arrived
    // meanwhile. Clearing here would mark a live document still holding
    // unstored content as clean, and the timed loop would skip it from then
    // on. Gate 2 reproduced exactly that.
    const { gate } = harness("fails");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  // Clearing them once the document HAS left memory is no longer the gate's
  // job — it belongs to the change-tracking extension, which owns the
  // bookkeeping it drops. Covered in services/__tests__/change-tracking.test.ts.

  it("reclaims its own arm, so no leftover can be spent by the library", async () => {
    // The Redis extension runs first (priority 1000 against our default 100)
    // and aborts the whole hook chain when another instance holds the
    // cross-instance lock, so our hook — and its consumption of the arm — is
    // skipped. A leftover would then be spent by the library's own
    // change-triggered store.
    const { gate } = harness("fails");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });

  it("alerts even when the rescue file could not be written", async () => {
    // The worst sub-case — the content now has no copy anywhere — was also
    // the only one that told nobody.
    const alerted: Array<{ rescuePath: string; reason: string }> = [];
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async () => true,
      writeRescue: async () => {
        throw new Error("disk full");
      },
      writeRescueNote: async () => {},
      alert: async (failure) => void alerted.push(failure),
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(alerted).toHaveLength(1);
    expect(alerted[0]?.reason).toContain("no copy anywhere");
  });
});

describe("the unload gate — when the library unloaded the document first", () => {
  // Gate 2 round 8. `storeDocumentNow` looks the document up in
  // `instance.documents` and returns false when the library has already
  // removed it — nothing was written and nothing could be. From out here that
  // is indistinguishable from an unspent permission unless the gate checks it
  // separately, and the two send an operator to different places: one says
  // "your hook chain was aborted", the other says "the document was gone".
  //
  // The branch that tells them apart had no test at all: replacing its
  // condition with `if (false)` left all 426 collab tests green.

  it("says it could not confirm, not that nothing reached our extension", async () => {
    const alerted: StoreFailureAlert[] = [];
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (d: Y.Doc) => Y.encodeStateAsUpdate(d),
      // Exactly what the real `storeDocumentNow` returns once the library has
      // taken the document out of `instance.documents`.
      storeNow: async () => false,
      writeRescue: async () => "/rescue/1.yjs",
      writeRescueNote: async () => {},
      alert: async (failure) => void alerted.push(failure),
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(alerted).toHaveLength(1);
    expect(alerted[0]?.reason).toContain("could not confirm");
    expect(alerted[0]?.reason).not.toContain("never ran");
  });
});

describe("the unload gate — when nothing reached our extension", () => {
  // Gate 2 round 2 finding 5. In a multi-instance deployment the Redis
  // extension runs first (priority 1000 against our default 100) and aborts
  // the whole hook chain when another instance holds the cross-instance store
  // lock. The library catches that and resolves normally, so from out here it
  // is indistinguishable from a completed store — except that the arm is
  // still unspent. Without that signal the gate told an operator a healthy
  // database had refused the content.

  it("still writes the rescue file — losing the lock is not proof the content is safe", async () => {
    const { gate, rescued } = harness("not-reached");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(rescued).toHaveLength(1);
  });

  it("says so, instead of claiming the store did not land", async () => {
    const { gate, alerted } = harness("not-reached");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(alerted).toHaveLength(1);
    // Deliberately worded so that ONLY the current text passes. The previous
    // assertion matched "never ran|another instance", and the text it was
    // meant to replace contained both — so it passed whether or not the fix
    // had landed, and it certified a change that had not been made.
    expect(alerted[0]?.reason).toContain("cannot tell why");
    expect(alerted[0]?.reason).not.toContain("another instance held");
    expect(alerted[0]?.reason).not.toMatch(/did not land/);
  });

  it("leaves no arm behind for a change-triggered store to spend", async () => {
    const { gate } = harness("not-reached");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(consumeTimedStoreArm(DOC)).toBe(false);
  });
});

describe("the unload gate — a write that is taking its time", () => {
  // A store either lands or it does not, and the write itself is what says
  // which. A clock racing it cancels nothing, so giving up on it produces no
  // answer at all — just a third state, "I cannot say", which then rescued the
  // document and mailed an operator about a database that was merely busy.
  // Three such alerts fired in smoke against a database answering in 250ms.

  // Gate 2 round 5 finding 3: racing this against a 50 ms timer only proved
  // nobody gives up inside 50 ms — the deleted 3000 ms deadline could be pasted
  // straight back with the suite green. Fake timers make the assertion mean
  // what it says: advance an hour and any `setTimeout` on this path fires.

  it("waits for the answer, even an hour later, and rescues nothing meanwhile", async () => {
    vi.useFakeTimers();
    try {
      const { gate, rescued, alerted } = harness("hangs");
      noteDocumentChange(DOC);

      let movedOn = false;
      void gate
        .beforeUnloadDocument({ documentName: DOC, document: documentWithText("hello") })
        .then(() => {
          movedOn = true;
        });
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(movedOn).toBe(false);
      expect(rescued).toHaveLength(0);
      expect(alerted).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("what the gate leaves behind for whoever has to sort it out", () => {
  // Gate 2 round 2 findings 9 and 13. Acceptance #20 asked for one log line
  // carrying the error, the document, the size, the rescue path and a stable
  // message name; what shipped had no error in it, and none of the gate's log
  // names were asserted anywhere, so any of them could have been renamed
  // without a single test noticing.

  it("writes a note beside the rescue file saying what it is", async () => {
    const notes: Array<{ rescuePath: string; note: { reason: string } }> = [];
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async ({ name }) => {
        if (consumeTimedStoreArm(name)) noteStoreOutcome(name, "refused");
        return true;
      },
      writeRescue: async () => "/rescue/1.yjs",
      writeRescueNote: async (rescuePath, note) => void notes.push({ rescuePath, note }),
      alert: async () => {},
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(notes).toHaveLength(1);
    expect(notes[0]?.rescuePath).toBe("/rescue/1.yjs");
    expect(notes[0]?.note.reason).toBe("the final store attempt did not land");
  });

  it("logs the failure under a stable name, with everything needed to act on it", async () => {
    const { gate } = harness("fails");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        documentName: DOC,
        bytes: expect.any(Number),
        rescuePath: "/rescue/1.yjs",
        attempt: "refused",
      }),
      "collab_store_unrecoverable",
    );
  });

  it("logs under a stable name when even the rescue file could not be written", async () => {
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async ({ name }) => {
        if (consumeTimedStoreArm(name)) noteStoreOutcome(name, "refused");
        return true;
      },
      writeRescue: async () => {
        throw new Error("the rescue directory is gone");
      },
      writeRescueNote: async () => {},
      alert: async () => {},
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), documentName: DOC }),
      "collab_rescue_write_failed",
    );
  });

  it("logs under a stable name when the attempt itself threw", async () => {
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async () => {
        throw new Error("the connection went away");
        return true;
      },
      writeRescue: async () => "/rescue/1.yjs",
      writeRescueNote: async () => {},
      alert: async () => {},
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), documentName: DOC }),
      "collab_final_store_attempt_errored",
    );
  });
});

describe("settling the same document twice", () => {
  // The library keeps a document reachable for the whole of
  // `beforeUnloadDocument` — it deletes it from `instance.documents` only
  // after the chain resolves — so a second unload of the same document can
  // begin while the first is still waiting on its write. That produced two
  // rescue files for one document, and the second alert was swallowed by the
  // per-document window, so an operator was told about one file and found two.

  it("settles again on a later unload when the document survived the first", async () => {
    // hocuspocus re-checks `shouldUnloadDocument` after the hook returns and
    // abandons the unload when a connection arrived meanwhile. That document
    // is still live and still holds unstored content, so its next real
    // departure deserves its own attempt — the claim is for one departure,
    // not for the document's whole life.
    const { gate, rescued } = harness("fails");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });
    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(rescued).toHaveLength(2);
  });

});

describe("what the operator is told when there is no answer", () => {
  // Gate 2 round 4 findings 1, 4, 9 and 11. `not-reached` used to be reported
  // as "another instance held the cross-instance store lock" — one named cause
  // for a signal that covers several, and on a single-instance deployment it
  // states the opposite of what happened. The tracker's own docstring already
  // said the gate must not name a cause it cannot see; the gate did anyway.

  it("names no cause at all when nothing reached our extension", async () => {
    const { gate, alerted } = harness("not-reached");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(alerted[0]?.reason).toContain("cannot tell why");
    expect(alerted[0]?.reason).not.toContain("another instance held");
  });

  it("does not claim nothing reached us when another writer took over", async () => {
    // The round arms BEFORE calling the library, so it can arm over the gate's
    // permission while the gate's attempt is in flight. The gate then cannot
    // confirm — but "cannot confirm" is not "nothing reached us", and the
    // superseding attempt may well have stored the document.
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async ({ name }) => {
        // Somebody else's round arms over ours and stores it.
        armTimedStore(name);
        consumeTimedStoreArm(name);
        commitStore(name, beginStore(name));
        noteStoreOutcome(name, "stored");
        return true;
      },
      writeRescue: async () => "/rescue/1.yjs",
      writeRescueNote: async () => {},
      alert: async (failure) => void alerted.push(failure),
    });
    const alerted: StoreFailureAlert[] = [];
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(alerted).toHaveLength(0);
  });
});

describe("a write that landed while new content was arriving", () => {
  // The reachable state: the ticket is taken before the encode, so an update
  // arriving mid-write leaves the document dirty while the write itself lands.
  // The rescue file is encoded AFTER the attempt, so it holds that content and
  // the database does not — and the alert has to say so, because an operator
  // deciding whether to restore the file needs to know it is the newer copy.

  it("tells the operator the FILE is the newer copy on an ordinary unload", async () => {
    // Ordinary order: store first, then encode the rescue file. So the file
    // was serialised after the write and does hold what arrived during it.
    const alerted: StoreFailureAlert[] = [];
    const gate = createUnloadGate({
      instanceId: "inst-a",
      encode: (d: Y.Doc) => Y.encodeStateAsUpdate(d),
      storeNow: async ({ name }) => {
        if (!consumeTimedStoreArm(name)) return true;
        const ticket = beginStore(name);
        noteDocumentChange(name);
        commitStore(name, ticket);
        noteStoreOutcome(name, "stored");
        return true;
      },
      writeRescue: async () => "/rescue/1.yjs",
      writeRescueNote: async () => {},
      alert: async (failure) => void alerted.push(failure),
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(alerted).toHaveLength(1);
    expect(alerted[0]?.reason).toContain("this file holds it");
  });

});
