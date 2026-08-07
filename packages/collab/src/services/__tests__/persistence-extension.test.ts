// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The persistence extension is the one place that decides whether a store
 * actually happens. hocuspocus fires `onStoreDocument` after every edit and
 * offers no way to turn that off, so the gate lives here: no arm from the
 * timed loop or the unload gate means the call returns having encoded
 * nothing and touched no database.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as Y from "yjs";

// `vi.hoisted` so the stub exists when the hoisted `vi.mock` factory runs.
const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@breatic/core", () => ({
  createLogger: () => mockLogger,
}));

import { createPersistenceExtension, storeDocumentNow } from "@collab/services/persistence.js";
import {
  armTimedStore,
  releaseTimedStoreArm,
  forgetDocument,
  hasUnsavedContent,
  noteDocumentChange,
} from "@collab/services/store-tracker.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";

/** Build a document carrying some text, standing in for a live one. */
function documentWithText(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, text);
  return doc;
}

/**
 * Assemble the extension with counting stand-ins for encoding and writing.
 * @param storeImpl - What the write should do.
 * @returns The extension plus the two call counters.
 */
function harness(storeImpl: () => Promise<void> = async () => {}) {
  const encodes: number[] = [];
  const writes: Array<{ documentName: string; state: Uint8Array }> = [];
  const extension = createPersistenceExtension({
    fetch: async () => null,
    store: async ({ documentName, state }) => {
      writes.push({ documentName, state });
      await storeImpl();
    },
    encode: (document: Y.Doc) => {
      const bytes = Y.encodeStateAsUpdate(document);
      encodes.push(bytes.length);
      return bytes;
    },
  });
  return { extension, encodes, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDocument(DOC);
});

describe("createPersistenceExtension — who is allowed to write", () => {
  it("a store the library started on its own encodes nothing and writes nothing", async () => {
    const { extension, encodes, writes } = harness();
    noteDocumentChange(DOC);

    await extension.onStoreDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(encodes).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("an armed store encodes once and writes those exact bytes", async () => {
    const { extension, encodes, writes } = harness();
    const document = documentWithText("hello");
    noteDocumentChange(DOC);
    armTimedStore(DOC);

    await extension.onStoreDocument({ documentName: DOC, document });

    expect(encodes).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.documentName).toBe(DOC);
    expect(new Y.Doc()).toBeDefined();
    const restored = new Y.Doc();
    Y.applyUpdate(restored, writes[0]!.state);
    expect(restored.getText("body").toString()).toBe("hello");
  });

  it("one arm permits one store, not two", async () => {
    const { extension, writes } = harness();
    noteDocumentChange(DOC);
    armTimedStore(DOC);

    const document = documentWithText("hello");
    await extension.onStoreDocument({ documentName: DOC, document });
    await extension.onStoreDocument({ documentName: DOC, document });

    expect(writes).toHaveLength(1);
  });
});

describe("createPersistenceExtension — what a store leaves behind", () => {
  it("a successful store marks the document as saved", async () => {
    const { extension } = harness();
    noteDocumentChange(DOC);
    armTimedStore(DOC);

    await extension.onStoreDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(hasUnsavedContent(DOC)).toBe(false);
  });

  it("a failed store leaves the document unsaved, so the next round retries it", async () => {
    const { extension } = harness(async () => {
      throw new Error("database is down");
    });
    noteDocumentChange(DOC);
    armTimedStore(DOC);

    await extension.onStoreDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("a failed store does not throw", async () => {
    // Deliberate. Letting it escape makes hocuspocus skip afterStoreDocument,
    // which leaves the cross-instance lock held until its TTL and — worse —
    // skips the re-check that unloads a document whose last connection went
    // away mid-write. The counters carry the truth instead.
    const { extension } = harness(async () => {
      throw new Error("database is down");
    });
    noteDocumentChange(DOC);
    armTimedStore(DOC);

    await expect(
      extension.onStoreDocument({ documentName: DOC, document: documentWithText("hello") }),
    ).resolves.toBeUndefined();
  });

  it("a failed store logs the error, the document, and how much was at stake", async () => {
    const { extension } = harness(async () => {
      throw new Error("database is down");
    });
    noteDocumentChange(DOC);
    armTimedStore(DOC);

    await extension.onStoreDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    const [context, message] = mockLogger.error.mock.calls[0]!;
    expect(message).toBe("collab_store_failed");
    expect(context).toMatchObject({ documentName: DOC });
    expect((context as { bytes: number }).bytes).toBeGreaterThan(0);
    expect((context as { err: Error }).err).toBeInstanceOf(Error);
  });

  it("a store that was never armed logs nothing — it is not a failure", async () => {
    const { extension } = harness();
    noteDocumentChange(DOC);

    await extension.onStoreDocument({ documentName: DOC, document: documentWithText("hello") });

    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("the origin a timed store carries", () => {
  // Gate 2 round 2 finding 11. @hocuspocus/extension-redis is the only reader
  // of `lastTransactionOrigin` in the whole library, and it reads it for one
  // purpose: `afterStoreDocument` waits `disconnectDelay` (1000ms by default)
  // whenever the source is "local". The library holds the save mutex across
  // both store hooks, so copying the library's own "local" origin cost every
  // timed store a second of held mutex, every round, forever — and added a
  // second to every document's settle on the way out.
  //
  // The delay exists for a direct connection disconnecting, where peers need a
  // beat to receive the sync before the document unloads. A timed store is not
  // an unload. `isTransactionOrigin` recognises only "connection", "redis" and
  // "local", so anything else makes that check fall through — which is the
  // whole mechanism, and why this asserts on the source rather than on a clock.

  it("is not one the library recognises, so nothing waits on it", async () => {
    const seen: Array<{ lastTransactionOrigin: { source: string } }> = [];
    const document = { name: DOC, getConnectionsCount: () => 1 };
    const driver = {
      documents: new Map([[DOC, document]]),
      storeDocumentHooks: (
        _document: unknown,
        payload: { lastTransactionOrigin: { source: string } },
      ): unknown => {
        seen.push(payload);
        return Promise.resolve();
      },
    };

    // A stand-in, so it has to be converted. This is the only conversion left
    // anywhere on this path: both production call sites pass the real
    // instance unchanged.
    await storeDocumentNow(driver as unknown as Parameters<typeof storeDocumentNow>[0], DOC);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.lastTransactionOrigin.source).not.toBe("local");
    expect(seen[0]?.lastTransactionOrigin.source).not.toBe("redis");
    expect(seen[0]?.lastTransactionOrigin.source).not.toBe("connection");
  });
});

describe("an edit that arrives while the write is in flight", () => {
  // Acceptance #7, and Gate 2 round 3 finding 9. The invariant was pinned only
  // against hand-called `beginStore`/`commitStore`, never against the extension
  // that has to get the order right. Measured: moving the ticket from before
  // the encode to the moment of commit left all 411 collab tests green, and the
  // consequence is a document that reads as saved while holding content the
  // database never received — the timed round skips it and the unload gate lets
  // it go with no rescue file and nothing logged.
  //
  // This goes through `createPersistenceExtension`, so the ordering it depends
  // on is the ordering under test.

  it("still reads as unsaved once the store returns", async () => {
    const document = new Y.Doc();
    let arrived: (() => void) | undefined;
    const midWrite = new Promise<void>((resolve) => {
      arrived = resolve;
    });

    const extension = createPersistenceExtension({
      fetch: async () => null,
      store: async () => {
        // The edit lands after the bytes were taken and before the write
        // returns — the one window the ticket exists for.
        noteDocumentChange(DOC);
        arrived?.();
      },
    });

    noteDocumentChange(DOC);
    armTimedStore(DOC);
    await extension.onStoreDocument({ documentName: DOC, document });
    await midWrite;

    expect(hasUnsavedContent(DOC)).toBe(true);
  });

  it("reads as saved when nothing arrives during the write", async () => {
    // The other half: without this, "always unsaved" would pass the test above
    // and store the same document forever.
    const document = new Y.Doc();
    const extension = createPersistenceExtension({
      fetch: async () => null,
      store: async () => {},
    });

    noteDocumentChange(DOC);
    armTimedStore(DOC);
    await extension.onStoreDocument({ documentName: DOC, document });

    expect(hasUnsavedContent(DOC)).toBe(false);
  });
});

describe("what the extension reports back about its own write", () => {
  // Gate 2 round 4 finding 7. Both report lines could be deleted with the whole
  // suite green: every test that asserted on an outcome fabricated it in its
  // own stub, so nothing checked that the EXTENSION reports anything at all.
  // Delete the "stored" line and every landed final write reads as unconfirmed
  // — rescue file kept, operator emailed, per dirty document per shutdown.
  // Delete the "refused" line and a genuinely refused write is reported as
  // "may still have landed", which is the misdiagnosis this whole rework
  // exists to remove.

  it("reports that the write landed", async () => {
    const document = new Y.Doc();
    const extension = createPersistenceExtension({
      fetch: async () => null,
      store: async () => {},
    });
    noteDocumentChange(DOC);
    const arm = armTimedStore(DOC);

    await extension.onStoreDocument({ documentName: DOC, document });

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: true, outcome: "stored" });
  });

  it("reports that the database refused it", async () => {
    const document = new Y.Doc();
    const extension = createPersistenceExtension({
      fetch: async () => null,
      store: async () => {
        throw new Error("the database is down");
      },
    });
    noteDocumentChange(DOC);
    const arm = armTimedStore(DOC);

    await extension.onStoreDocument({ documentName: DOC, document });

    expect(releaseTimedStoreArm(DOC, arm)).toEqual({ ran: true, outcome: "refused" });
  });
});
