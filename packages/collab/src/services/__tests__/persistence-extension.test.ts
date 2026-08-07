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
  // timed store a second of held mutex, every round, forever — and ate a
  // quarter of the whole shutdown budget on the way out.
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

    await storeDocumentNow(driver, DOC);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.lastTransactionOrigin.source).not.toBe("local");
    expect(seen[0]?.lastTransactionOrigin.source).not.toBe("redis");
    expect(seen[0]?.lastTransactionOrigin.source).not.toBe("connection");
  });
});
