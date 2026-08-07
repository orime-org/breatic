// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The timed loop is the only thing that stores a document while people are
 * still editing it, and the only thing that retries one whose store failed.
 * Nothing else re-attempts: hocuspocus does not (measured), and an idle
 * document produces no further edits to piggyback on.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@breatic/core", () => ({ createLogger: () => mockLogger }));

import { createStoreLoop } from "@collab/services/store-loop.js";
import {
  consumeTimedStoreArm,
  forgetDocument,
  noteDocumentChange,
  noteStoreOutcome,
} from "@collab/services/store-tracker.js";

const DIRTY = "project-p/document-dirty";
const CLEAN = "project-p/document-clean";
const OTHER = "project-p/document-other";

beforeEach(() => {
  vi.clearAllMocks();
  [DIRTY, CLEAN, OTHER].forEach(forgetDocument);
});

/**
 * Build a loop over a fixed set of document names.
 * @param names - Documents pretending to be in memory.
 * @param storeNow - What "ask hocuspocus to store this" should do.
 * @returns The loop plus the names it asked to store, in order.
 */
function harness(names: string[], storeNow?: (name: string) => Promise<void>) {
  const stored: string[] = [];
  const loop = createStoreLoop({
    intervalMs: 10_000,
    listDocuments: () => names.map((name) => ({ name })),
    storeNow: async ({ name }) => {
      stored.push(name);
      // The real path reaches the persistence extension, which spends the arm
      // and then reports what its write did. Standing in for both is what
      // separates an ordinary round from one whose chain was aborted upstream
      // or whose write never came back — a stub that only spends the arm makes
      // every round look unconfirmed.
      if (consumeTimedStoreArm(name)) noteStoreOutcome(name, "stored");
      if (storeNow) await storeNow(name);
      return true;
    },
  });
  return { loop, stored };
}

describe("the timed store loop", () => {
  it("skips a document with nothing outstanding", async () => {
    const { loop, stored } = harness([CLEAN]);

    await loop.runOnce();

    expect(stored).toHaveLength(0);
  });

  it("stores a document that has outstanding content", async () => {
    const { loop, stored } = harness([DIRTY]);
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(stored).toEqual([DIRTY]);
  });

  it("arms the document before asking for the store", async () => {
    // Without the arm the persistence extension returns without writing, so
    // a loop that forgets it would silently store nothing at all. Built
    // directly rather than through the harness, because the observation here
    // IS the harness's stand-in for the persistence extension.
    let armedAtStoreTime = false;
    const loop = createStoreLoop({
      intervalMs: 10_000,
      listDocuments: () => [{ name: DIRTY }],
      storeNow: async () => {
        armedAtStoreTime = consumeTimedStoreArm(DIRTY);
        return true;
      },
    });
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(armedAtStoreTime).toBe(true);
  });

  it("stores only the outstanding ones out of a mixed set", async () => {
    const { loop, stored } = harness([CLEAN, DIRTY, OTHER]);
    noteDocumentChange(DIRTY);
    noteDocumentChange(OTHER);

    await loop.runOnce();

    expect(stored).toEqual([DIRTY, OTHER]);
  });

  it("keeps going through the round when one document throws", async () => {
    const { loop, stored } = harness([DIRTY, OTHER], async (name) => {
      if (name === DIRTY) throw new Error("boom");
    });
    noteDocumentChange(DIRTY);
    noteDocumentChange(OTHER);

    await loop.runOnce();

    expect(stored).toEqual([DIRTY, OTHER]);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  it("does not start a second write of a document whose first is still out", async () => {
    // A slow database makes a round outlast the interval. Two writes of the
    // same document in flight together is the thing to prevent: the second
    // would carry a snapshot taken before the first landed.
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { loop, stored } = harness([DIRTY], async () => blocked);
    noteDocumentChange(DIRTY);

    const first = loop.runOnce();
    await loop.runOnce();
    expect(stored).toEqual([DIRTY]);

    release?.();
    await first;
  });

  it("stops running once stopped", async () => {
    vi.useFakeTimers();
    try {
      const { loop, stored } = harness([DIRTY]);
      noteDocumentChange(DIRTY);

      loop.start();
      loop.stop();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(stored).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs a round every interval once started", async () => {
    vi.useFakeTimers();
    try {
      const { loop, stored } = harness([DIRTY]);
      loop.start();

      noteDocumentChange(DIRTY);
      await vi.advanceTimersByTimeAsync(10_000);
      noteDocumentChange(DIRTY);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(stored).toEqual([DIRTY, DIRTY]);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a round that could not confirm the write", () => {
  // Gate 2 round 2 findings 1, 5 and 8. This does not lose content — the
  // document stays in memory and still reads as dirty, so the next round picks
  // it up. It is logged because a document that never wins the cross-instance
  // lock is otherwise invisible: it just quietly stays dirty round after round
  // with nothing to show for it.

  it("records that the hook chain never reached our extension", async () => {
    // An aborted chain leaves the arm the round issued untouched — it does
    // not replace it. Re-arming would mint a different token, which reads as
    // "somebody else armed it", not as "nothing reached us".
    const loop = createStoreLoop({
      intervalMs: 10_000,
      listDocuments: () => [{ name: DIRTY }],
      storeNow: async () => true,
    });
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ documentName: DIRTY, outcome: "not-reached" }),
      "collab_store_round_document_unconfirmed",
    );
  });

  it("records an extension that ran and reported nothing", async () => {
    // Only reachable by our own extension throwing before its try block —
    // encoding the document is the one step out there. It used to also cover
    // "the round stopped waiting", which is gone: a round waits for its answer.
    const loop = createStoreLoop({
      intervalMs: 10_000,
      listDocuments: () => [{ name: DIRTY }],
      storeNow: async ({ name }) => {
        consumeTimedStoreArm(name);
        return true;
      },
    });
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ documentName: DIRTY, outcome: "no-result" }),
      "collab_store_round_document_unconfirmed",
    );
  });

  it("says nothing about an ordinary round", async () => {
    const { loop } = harness([DIRTY]);
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("one document whose store never comes back", () => {
  // Gate 2 round 5 finding 2. Removing the per-document deadline took away the
  // thing that used to let a round step past a wedged write. What replaces it
  // is not another clock — it is the right MUTUAL-EXCLUSION GRAIN. The guard
  // exists to stop two writes of the SAME document overlapping; making it
  // whole-round meant one stuck write silently retired the only retry
  // mechanism in the process, for every other document too.

  it("still stores the other documents in the same round", async () => {
    const stored: string[] = [];
    const loop = createStoreLoop({
      intervalMs: 10_000,
      listDocuments: () => [{ name: DIRTY }, { name: OTHER }],
      storeNow: async ({ name }) => {
        stored.push(name);
        if (name === DIRTY) return new Promise<boolean>(() => {});
        if (consumeTimedStoreArm(name)) noteStoreOutcome(name, "stored");
        return true;
      },
    });
    noteDocumentChange(DIRTY);
    noteDocumentChange(OTHER);

    void loop.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stored).toContain(OTHER);
  });

  it("lets later rounds run, skipping only the document still being stored", async () => {
    const stored: string[] = [];
    const loop = createStoreLoop({
      intervalMs: 10_000,
      listDocuments: () => [{ name: DIRTY }, { name: OTHER }],
      storeNow: async ({ name }) => {
        stored.push(name);
        if (name === DIRTY) return new Promise<boolean>(() => {});
        if (consumeTimedStoreArm(name)) noteStoreOutcome(name, "stored");
        return true;
      },
    });
    noteDocumentChange(DIRTY);
    noteDocumentChange(OTHER);

    void loop.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
    noteDocumentChange(OTHER);
    void loop.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The healthy document got both rounds; the wedged one was asked once and
    // is not asked again while its write is still out there — two writes of one
    // document in flight together is the thing the guard exists to prevent.
    expect(stored.filter((n) => n === OTHER)).toHaveLength(2);
    expect(stored.filter((n) => n === DIRTY)).toHaveLength(1);
  });
});

describe("a store that takes its time", () => {
  // A store is one event with two outcomes: it lands, or it does not. A clock
  // racing it answers neither question — it cannot cancel the write, so all it
  // does is make this side stop listening and invent a third outcome, "I do not
  // know", which the document then gets rescued and alerted on. Three such
  // alerts fired in smoke against a healthy database that answers in 250ms.
  //
  // Gate 2 round 5 finding 3: this test used to race the hung store against a
  // 50 ms timer, which only proves nobody gives up INSIDE 50 ms. The three
  // deleted deadlines (3000 / 3000 / 4000 ms) could all be pasted back with the
  // whole suite green. Fake timers are what make the assertion mean what it
  // says: advance an hour, and any `setTimeout` anywhere on this path fires.

  it("waits for the answer, even an hour later", async () => {
    vi.useFakeTimers();
    try {
      const loop = createStoreLoop({
        intervalMs: 10_000,
        listDocuments: () => [{ name: DIRTY }],
        storeNow: async ({ name }) => {
          consumeTimedStoreArm(name);
          return new Promise<boolean>(() => {});
        },
      });
      noteDocumentChange(DIRTY);

      let movedOn = false;
      void loop.runOnce().then(() => {
        movedOn = true;
      });
      await vi.advanceTimersByTimeAsync(3_600_000);

      expect(movedOn).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
