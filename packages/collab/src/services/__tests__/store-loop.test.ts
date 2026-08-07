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
    storeTimeoutMs: 5_000,
    listDocuments: () => names.map((name) => ({ name })),
    storeNow: async ({ name }) => {
      stored.push(name);
      // The real path reaches the persistence extension, which spends the arm
      // before it writes. Standing in for that is what separates an ordinary
      // round from one whose hook chain was aborted upstream — a stub that
      // never spends the arm makes every test look like the latter.
      consumeTimedStoreArm(name);
      if (storeNow) await storeNow(name);
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
      storeTimeoutMs: 5_000,
      listDocuments: () => [{ name: DIRTY }],
      storeNow: async () => {
        armedAtStoreTime = consumeTimedStoreArm(DIRTY);
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

  it("does not start a round while the previous one is still running", async () => {
    // A slow database makes a round outlast the interval. Overlapping rounds
    // would put two writes of the same document in flight at once.
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
  // Gate 2 round 2 findings 1, 5 and 8. Neither of these loses content — the
  // document stays in memory and still reads as dirty, so the next round picks
  // it up. They are logged because a document that never wins the
  // cross-instance lock, or never finishes a write, is otherwise invisible: it
  // just quietly stays dirty round after round with nothing to show for it.

  it("records that the hook chain never reached our extension", async () => {
    // An aborted chain leaves the arm the round issued untouched — it does
    // not replace it. Re-arming would mint a different token, which reads as
    // "somebody else armed it", not as "nothing reached us".
    const loop = createStoreLoop({
      intervalMs: 10_000,
      storeTimeoutMs: 5_000,
      listDocuments: () => [{ name: DIRTY }],
      storeNow: async () => {},
    });
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ documentName: DIRTY, outcome: "not-reached" }),
      "collab_store_round_document_unconfirmed",
    );
  });

  it("records a write that had not come back when the round moved on", async () => {
    const loop = createStoreLoop({
      intervalMs: 10_000,
      storeTimeoutMs: 10,
      listDocuments: () => [{ name: DIRTY }],
      storeNow: async ({ name }) => {
        consumeTimedStoreArm(name);
        return new Promise<void>(() => {});
      },
    });
    noteDocumentChange(DIRTY);

    await loop.runOnce();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ documentName: DIRTY, outcome: "still-in-flight" }),
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
