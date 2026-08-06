// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import {
  commitStore,
  consumeTimedStoreArm,
  forgetDocument,
  hasUnsavedContent,
  noteDocumentChange,
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
function harness(outcome: "lands" | "fails" | "hangs" = "lands") {
  const rescued: Array<{ documentName: string; state: Uint8Array }> = [];
  const deleted: string[] = [];
  const alerted: Array<{ documentName: string; rescuePath: string }> = [];
  const storeCalls: string[] = [];

  const gate = createUnloadGate({
    finalAttemptTimeoutMs: 50,
    encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
    storeNow: async ({ name }) => {
      storeCalls.push(name);
      // The real path goes through hocuspocus into the persistence
      // extension, which consumes the arm and commits the counter. Stand in
      // for exactly that, so the gate is judged on the counter like in
      // production rather than on this stub's return value.
      if (outcome === "hangs") return new Promise<void>(() => {});
      if (!consumeTimedStoreArm(name)) return;
      if (outcome === "fails") return;
      commitStore(name, beginStore(name));
    },
    writeRescue: async ({ documentName, state }) => {
      rescued.push({ documentName, state });
      return `/rescue/${rescued.length}.yjs`;
    },
    deleteRescue: async (path: string) => void deleted.push(path),
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

  it("treats an attempt that never returns as a failure, within the timeout", async () => {
    // The yjs pool inherits postgres.js's 30s connect timeout, which is many
    // times the whole shutdown budget. Waiting for it means losing the file.
    const { gate, rescued } = harness("hangs");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(rescued).toHaveLength(1);
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

  it("clears them once the document has actually left memory", async () => {
    const { gate } = harness("fails");
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });
    gate.afterUnloadDocument({ documentName: DOC });

    expect(hasUnsavedContent(DOC)).toBe(false);
  });

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
      finalAttemptTimeoutMs: 50,
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async () => {},
      writeRescue: async () => {
        throw new Error("disk full");
      },
      deleteRescue: async () => {},
      alert: async (failure) => void alerted.push(failure),
    });
    noteDocumentChange(DOC);

    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });

    expect(alerted).toHaveLength(1);
    expect(alerted[0]?.reason).toContain("no copy anywhere");
  });
});

describe("the unload gate — shutdown order", () => {
  it("writes the rescue file BEFORE attempting the store", async () => {
    // On shutdown the whole budget is 4 seconds and one attempt can outlast
    // it, so the fast, local write goes first.
    const order: string[] = [];
    const { gate } = harness("lands");
    noteDocumentChange(DOC);

    await gate.settleForShutdown({
      documentName: DOC,
      document: documentWithText("x"),
      onStep: (step: string) => order.push(step),
    });

    expect(order).toEqual(["rescue", "store"]);
  });

  it("deletes the rescue file once the store lands", async () => {
    const { gate, rescued, deleted } = harness("lands");
    noteDocumentChange(DOC);

    await gate.settleForShutdown({ documentName: DOC, document: documentWithText("x") });

    expect(rescued).toHaveLength(1);
    expect(deleted).toEqual(["/rescue/1.yjs"]);
  });

  it("keeps the rescue file and alerts when the store does not land", async () => {
    const { gate, deleted, alerted } = harness("fails");
    noteDocumentChange(DOC);

    await gate.settleForShutdown({ documentName: DOC, document: documentWithText("x") });

    expect(deleted).toHaveLength(0);
    expect(alerted).toHaveLength(1);
  });

  it("does nothing at all for a document with nothing outstanding", async () => {
    const { gate, rescued, storeCalls } = harness();

    await gate.settleForShutdown({ documentName: DOC, document: documentWithText("x") });

    expect(rescued).toHaveLength(0);
    expect(storeCalls).toHaveLength(0);
  });
});

describe("the unload gate — which order it picks", () => {
  it("uses the shutdown order once the process is shutting down", async () => {
    // The graceful-shutdown drains run in parallel, so a separate "settle
    // everything" drain would race the one destroying the server, with both
    // walking the same documents. The flag makes the ordinary unload path —
    // which server.destroy() drives anyway — do the right thing instead.
    const order: string[] = [];
    let shuttingDown = false;
    const rescued: string[] = [];
    const gate = createUnloadGate({
      finalAttemptTimeoutMs: 50,
      encode: (document: Y.Doc) => Y.encodeStateAsUpdate(document),
      storeNow: async ({ name }) => {
        order.push("store");
        if (!consumeTimedStoreArm(name)) return;
        commitStore(name, beginStore(name));
      },
      writeRescue: async ({ documentName }) => {
        order.push("rescue");
        rescued.push(documentName);
        return "/rescue/x.yjs";
      },
      deleteRescue: async () => {},
      alert: async () => {},
      isShuttingDown: () => shuttingDown,
    });

    noteDocumentChange(DOC);
    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });
    expect(order).toEqual(["store"]);

    order.length = 0;
    shuttingDown = true;
    forgetDocument(DOC);
    noteDocumentChange(DOC);
    await gate.beforeUnloadDocument({ documentName: DOC, document: documentWithText("x") });
    expect(order).toEqual(["rescue", "store"]);
  });
});
