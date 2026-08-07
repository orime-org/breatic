// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The timed store on a live Hocuspocus instance (#40).
 *
 * The unit tests judge each piece against a stand-in. These run the real
 * machinery: a real client edit reaching a real document, the library's own
 * change-triggered store firing, and the real unload path. Three things can
 * only be seen here.
 *
 *   the arm gate      the library fires `onStoreDocument` after every edit;
 *                     nothing but a live server proves ours declines it
 *   the unload gate   `beforeUnloadDocument` runs inside `unloadDocument`,
 *                     and whether awaiting work there still lets the document
 *                     go is a property of the library, not of our code
 *   the mid-write     a store holds `saveMutex`, and `shouldUnloadDocument`
 *   unload            reads that mutex. A store that bypasses the library
 *                     would leave a document with zero connections held
 *                     forever — the leak this design is built to avoid.
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

import { createLiveServer, connectLiveClient, waitFor } from "./helpers/live-hocuspocus.js";
import { createPersistenceExtension, storeDocumentNow } from "../services/persistence.js";
import { createStoreLoop } from "../services/store-loop.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import { createUnloadGate } from "../hooks/unload-gate.js";
import { forgetDocument, hasUnsavedContent } from "../services/store-tracker.js";

const DOC = "project-11111111-1111-4111-8111-111111111111/document-1";

/** Everything a live server plus our store subsystem needs. */
interface Harness {
  hocuspocus: ReturnType<typeof createLiveServer>;
  writes: Array<{ documentName: string; state: Uint8Array }>;
  encodes: string[];
  runRound: () => Promise<void>;
  storeGate: { current?: ReturnType<typeof createUnloadGate> };
}

/**
 * Stand up a live server wired the way production is.
 * @param options - Failure and slowness switches for the write.
 * @returns The server plus handles onto what it did.
 */
function harness(options: { failing?: boolean; delayMs?: number } = {}): Harness {
  const writes: Array<{ documentName: string; state: Uint8Array }> = [];
  const encodes: string[] = [];
  const storeGate: { current?: ReturnType<typeof createUnloadGate> } = {};

  const persistence = createPersistenceExtension({
    fetch: async () => null,
    store: async ({ documentName, state }) => {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.failing) throw new Error("probe: database is down");
      writes.push({ documentName, state });
    },
    encode: (document: Y.Doc) => {
      encodes.push("encode");
      return Y.encodeStateAsUpdate(document);
    },
  });

  const hocuspocus = createLiveServer({
    extensions: [
      // The real change tracker, so this exercises the same wiring the server
      // builds. A hand-rolled `onChange` counter here would go on passing
      // after production had stopped counting that way.
      createChangeTrackingExtension(),
      persistence,
      {
        beforeUnloadDocument: async (payload: {
          documentName: string;
          document: Y.Doc;
        }): Promise<void> => {
          await storeGate.current?.beforeUnloadDocument(payload);
        },
      },
    ],
  });

  storeGate.current = createUnloadGate({
    finalAttemptTimeoutMs: 2000,
    encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
    storeNow: ({ name }) => storeDocumentNow(hocuspocus, name),
    writeRescue: async () => "/rescue/x.yjs",
    deleteRescue: async () => {},
    alert: async () => {},
  });

  const loop = createStoreLoop({
    intervalMs: 10_000,
    storeTimeoutMs: 5_000,
    listDocuments: () => Array.from(hocuspocus.documents.keys(), (name) => ({ name })),
    storeNow: ({ name }) => storeDocumentNow(hocuspocus, name),
  });

  return { hocuspocus, writes, encodes, runRound: loop.runOnce, storeGate };
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetDocument(DOC);
});

describe("the timed store on a live server", () => {
  it("writes nothing when a client edits — the library's own store is declined", async () => {
    // debounce is 0 in the live helper, so the library fires its store hook
    // straight after the edit. Ours must encode nothing and write nothing.
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;

    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(h.writes).toHaveLength(0);
    expect(h.encodes).toHaveLength(0);
    expect(hasUnsavedContent(DOC)).toBe(true);
    client.close();
  });

  it("writes it on the next round of the loop", async () => {
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 50));

    await h.runRound();

    expect(h.writes).toHaveLength(1);
    const back = new Y.Doc();
    Y.applyUpdate(back, h.writes[0]!.state);
    expect(back.getText("body").toString()).toBe("hello");
    expect(hasUnsavedContent(DOC)).toBe(false);
    client.close();
  });

  it("skips a round that has nothing to do", async () => {
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 50));

    await h.runRound();
    await h.runRound();

    expect(h.writes).toHaveLength(1);
    client.close();
  });

  it("stores on the way out when the last client leaves with content outstanding", async () => {
    // Measured behaviour without the gate: no attempt is made at all and the
    // document is unloaded with the content still only in memory.
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    document.transact(() => {
      document.getText("body").insert(0, "typed before leaving");
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.writes).toHaveLength(0);

    client.close();
    await waitFor(() => h.writes.length > 0, "the gate's final store");

    const back = new Y.Doc();
    Y.applyUpdate(back, h.writes[0]!.state);
    expect(back.getText("body").toString()).toBe("typed before leaving");
  });

  it("still releases the document when the last connection goes away mid-write", async () => {
    // The leak this whole approach exists to avoid. shouldUnloadDocument is
    // false while saveMutex is held, and the only place that re-checks is the
    // tail of the library's own store. Going through it keeps that re-check;
    // writing straight to the database would strand the document here with
    // zero connections and nothing left to release it.
    const h = harness({ delayMs: 120 });
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 30));

    const round = h.runRound();
    await new Promise((r) => setTimeout(r, 30));
    client.close();
    await round;

    await waitFor(() => !h.hocuspocus.documents.has(DOC), "the document to be released");
    expect(h.hocuspocus.documents.has(DOC)).toBe(false);
  });

  it("notices an edit that only DELETES text", async () => {
    // The check this rework nearly shipped — a Yjs state vector — cannot see
    // a deletion, because deletes go into a delete set rather than advancing
    // any client's clock. A probe measured the loss: delete a paragraph, fail
    // the store, close the tab, and the deletion is gone while the check
    // reports nothing outstanding.
    const h = harness();
    const client = await connectLiveClient(h.hocuspocus, DOC);
    const document = h.hocuspocus.documents.get(DOC)!;
    document.transact(() => {
      document.getText("body").insert(0, "hello world");
    });
    await new Promise((r) => setTimeout(r, 50));
    await h.runRound();
    expect(hasUnsavedContent(DOC)).toBe(false);

    document.transact(() => {
      document.getText("body").delete(5, 6); // the text gets SHORTER
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(hasUnsavedContent(DOC)).toBe(true);

    await h.runRound();
    const back = new Y.Doc();
    Y.applyUpdate(back, h.writes.at(-1)!.state);
    expect(back.getText("body").toString()).toBe("hello");
    client.close();
  });

  it("leaves the content outstanding when the write fails, so a later round takes it", async () => {
    const failing = harness({ failing: true });
    const client = await connectLiveClient(failing.hocuspocus, DOC);
    const document = failing.hocuspocus.documents.get(DOC)!;
    document.transact(() => {
      document.getText("body").insert(0, "hello");
    });
    await new Promise((r) => setTimeout(r, 50));

    await failing.runRound();

    expect(failing.writes).toHaveLength(0);
    expect(hasUnsavedContent(DOC)).toBe(true);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ documentName: DOC }),
      "collab_store_failed",
    );
    client.close();
  });
});
