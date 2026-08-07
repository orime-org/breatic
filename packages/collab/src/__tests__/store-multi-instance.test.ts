// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The three multi-instance behaviours, exercised through the real mechanisms
 * rather than through two real instances (#40).
 *
 * Gate 2 caught all three as unverified. What makes them multi-instance is
 * not the second process — it is two library behaviours that a single
 * instance can be made to produce exactly:
 *
 *   a relayed update   arrives as a transaction whose origin is
 *                      `{ source: "redis" }`, which is what the Redis
 *                      extension applies it with. Our counter has to move on
 *                      it, or a surviving instance would never store on
 *                      behalf of one that died.
 *   losing the lock    the Redis extension runs first (priority 1000 against
 *                      our default 100) and throws SkipFurtherHooksError when
 *                      another instance holds the cross-instance lock, which
 *                      aborts the whole hook chain before ours is reached.
 *
 * Standing up two real instances would test the same two things through a
 * Redis round trip, at the cost of a service dependency and a timing-based
 * assertion. The mechanisms are reproduced directly instead; the round trip
 * itself was verified separately against two live instances.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@breatic/core", () => ({ createLogger: () => mockLogger }));

import { createLiveServer, connectLiveClient } from "./helpers/live-hocuspocus.js";
import { createChangeTrackingExtension } from "../services/change-tracking.js";
import { createPersistenceExtension, storeDocumentNow } from "../services/persistence.js";
import { createStoreLoop } from "../services/store-loop.js";
import {
  consumeTimedStoreArm,
  forgetDocument,
  hasUnsavedContent,
} from "../services/store-tracker.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";

beforeEach(() => {
  vi.clearAllMocks();
  forgetDocument(DOC);
});

/**
 * Stand up a live server, optionally with an extension that loses the lock.
 * @param options - Whether a higher-priority extension aborts the hook chain.
 * @returns The server, the writes it made, and a round of the timed loop.
 */
function harness(options: { lockLost?: boolean } = {}) {
  const writes: string[] = [];
  const extensions: unknown[] = [
    // The real one, not a stand-in. Counting used to be hand-rolled here on
    // an `onChange` hook, which stopped mirroring production the moment the
    // tracker moved off the hook chain — a test that exercises a mechanism
    // the server no longer uses is green about nothing.
    createChangeTrackingExtension(),
    createPersistenceExtension({
      fetch: async () => null,
      store: async ({ documentName }) => void writes.push(documentName),
    }),
  ]
  if (options.lockLost) {
    // Stands in for the Redis extension: higher priority, so it runs first,
    // and it aborts the chain exactly the way losing the lock does.
    extensions.unshift({
      priority: 1000,
      onStoreDocument: async (): Promise<void> => {
        // A plain Error rather than the library's SkipFurtherHooksError,
        // which lives in a package collab does not depend on directly. The
        // mechanism under test is identical either way: `hooks()` chains the
        // extensions with `.then`, so any rejection skips every hook behind
        // it — ours included. The only difference is which branch
        // `storeDocumentHooks` logs from afterwards.
        throw new Error("another instance is already storing this document");
      },
    })
  }

  const hocuspocus = createLiveServer({ extensions });
  const loop = createStoreLoop({
    intervalMs: 60_000,
    listDocuments: () => Array.from(hocuspocus.documents.keys(), (name) => ({ name })),
    storeNow: ({ name }) => storeDocumentNow(hocuspocus, name),
  });
  return { hocuspocus, writes, runRound: loop.runOnce };
}

describe("an update relayed from another instance", () => {
  it("counts, so the receiving instance knows it holds unstored content", async () => {
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    // Drain what loading and connecting produced.
    await new Promise((r) => setTimeout(r, 30));
    forgetDocument(DOC);

    // Exactly how @hocuspocus/extension-redis applies a peer's update.
    document.transact(
      () => {
        document.getText("body").insert(0, "typed on the other instance");
      },
      { source: "redis" },
    );
    await new Promise((r) => setTimeout(r, 30));

    expect(hasUnsavedContent(DOC)).toBe(true);
    client.close();
  });

  it("is then stored by this instance's own round, covering for the one that died", async () => {
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    await new Promise((r) => setTimeout(r, 30));
    forgetDocument(DOC);
    h.writes.length = 0;

    document.transact(
      () => {
        document.getText("body").insert(0, "only this instance still has it");
      },
      { source: "redis" },
    );
    await new Promise((r) => setTimeout(r, 30));

    await h.runRound();

    expect(h.writes).toEqual([DOC]);
    client.close();
  });
});

describe("losing the cross-instance store lock", () => {
  it("leaves no arm behind for the library's own store to spend", async () => {
    // The abort happens before our extension is reached, so nothing consumes
    // the arm the round just set. A leftover would be spent by the next
    // change-triggered store — the one write this design exists to prevent.
    const h = harness({ lockLost: true });
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    await new Promise((r) => setTimeout(r, 30));
    forgetDocument(DOC);

    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 30));

    await h.runRound();

    expect(consumeTimedStoreArm(DOC)).toBe(false);
    client.close();
  });

  it("writes nothing on that round, and leaves the content outstanding", async () => {
    const h = harness({ lockLost: true });
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    await new Promise((r) => setTimeout(r, 30));
    forgetDocument(DOC);
    h.writes.length = 0;

    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 30));

    await h.runRound();

    expect(h.writes).toHaveLength(0);
    expect(hasUnsavedContent(DOC)).toBe(true);
    client.close();
  });
});
