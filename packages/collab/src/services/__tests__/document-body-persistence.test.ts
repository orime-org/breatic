// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
  documentBodyRecords, documentBodySource, documentCommentThreads, encodeInitialSpaceContent,
  readDocumentBodyRecords, registerDocumentBodyRecords,
} from "@breatic/shared";
import { createPersistenceExtension } from "@collab/services/persistence.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import { armTimedStore, forgetDocument, hasUnsavedContent, releaseTimedStoreArm } from "@collab/services/store-tracker.js";

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("@breatic/core", async (original) => ({ ...await original<object>(), createLogger: () => logger }));

const NAME = "project-16190000-1111-4111-8111-111111111111/document-16190000-2222-4222-8222-222222222222";
const documents: Y.Doc[] = [];

/**
 * Opens an independently loaded current production seed.
 * @returns A test-owned native records document.
 * @throws {Error} If the production seed cannot be decoded.
 */
function seeded(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  Y.applyUpdate(doc, encodeInitialSpaceContent("document"));
  return doc;
}

/**
 * Opens a stored update for an independent roundtrip assertion.
 * @param bytes - The exact snapshot sent to storage.
 * @returns A test-owned native document.
 * @throws {Error} If the update cannot be decoded.
 */
function restored(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  Y.applyUpdate(doc, bytes);
  return doc;
}

/**
 * Reads one seed's actual native source without inventing a parallel body.
 * @param doc - A current records document.
 * @returns Its first registered source.
 * @throws {Error} If no complete source exists.
 */
function source(doc: Y.Doc): Y.Text {
  const result = readDocumentBodyRecords(doc);
  if (result.status !== "ready") throw new Error("Expected complete seed records");
  const first = result.body.sources.keys().next().value;
  if (first === undefined) throw new Error("Expected seed source");
  return documentBodySource(doc, first);
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
  forgetDocument(NAME);
  vi.clearAllMocks();
});

describe("records through the actual persistence extension", () => {
  it("waits for prepared bytes before applying a single load update", async () => {
    const original = seeded();
    documentCommentThreads(original).set("thread", { text: "Original", replies: ["Reply"] });
    const bytes = Y.encodeStateAsUpdate(original);
    let complete: ((value: Uint8Array) => void) | undefined;
    const prepared = new Promise<Uint8Array>((resolve) => { complete = resolve; });
    const target = restored(new Uint8Array([0, 0]));
    let updates = 0;
    target.on("update", () => { updates += 1; });
    const extension = createPersistenceExtension({ fetch: () => prepared });
    const loading = extension.onLoadDocument({ documentName: NAME, document: target });
    expect(updates).toBe(0);
    expect(documentBodyRecords(target).metadata.toJSON()).toEqual({});
    if (complete === undefined) throw new Error("Missing preparation resolver");
    complete(bytes);
    await loading;
    expect(updates).toBe(1);
    expect(readDocumentBodyRecords(target)).toEqual(readDocumentBodyRecords(original));
    expect(documentCommentThreads(target).toJSON()).toEqual({ thread: { text: "Original", replies: ["Reply"] } });
  });

  it("propagates the original preparation error and applies no partial state", async () => {
    const failure = new Error("preparation commit rejected");
    const target = restored(new Uint8Array([0, 0]));
    let updates = 0;
    target.on("update", () => { updates += 1; });
    const extension = createPersistenceExtension({ fetch: async () => { throw failure; } });
    await expect(extension.onLoadDocument({ documentName: NAME, document: target })).rejects.toBe(failure);
    expect(updates).toBe(0);
    expect(documentBodyRecords(target).metadata.toJSON()).toEqual({});
  });

  it("counts real registration and source deletion updates and preserves their stored bytes", async () => {
    const doc = seeded();
    const tracker = createChangeTrackingExtension();
    await tracker.afterLoadDocument({ documentName: NAME, document: doc });
    expect(hasUnsavedContent(NAME)).toBe(false);
    registerDocumentBodyRecords(doc, { contexts: [{ id: "saved-context", dependencies: [] }] });
    expect(hasUnsavedContent(NAME)).toBe(true);
    const text = source(doc);
    text.insert(1, "AB", { ctx: "saved-context" });
    documentCommentThreads(doc).set("thread", { text: "Keep", replies: ["Reply"] });
    let saved: Uint8Array = new Uint8Array();
    const extension = createPersistenceExtension({
      store: async ({ state }) => { saved = state; }, recordEdit: () => {},
    });
    const firstArm = armTimedStore(NAME);
    await extension.onStoreDocument({ documentName: NAME, document: doc });
    releaseTimedStoreArm(NAME, firstArm);
    expect(hasUnsavedContent(NAME)).toBe(false);
    text.delete(1, 1);
    expect(hasUnsavedContent(NAME)).toBe(true);
    const secondArm = armTimedStore(NAME);
    await extension.onStoreDocument({ documentName: NAME, document: doc });
    releaseTimedStoreArm(NAME, secondArm);
    const loaded = restored(saved);
    expect(source(loaded).toDelta()).toEqual(text.toDelta());
    expect(source(loaded).length).toBe(3);
    expect(documentCommentThreads(loaded).toJSON()).toEqual({ thread: { text: "Keep", replies: ["Reply"] } });
    expect(documentBodyRecords(loaded).contexts.toJSON()).toEqual(documentBodyRecords(doc).contexts.toJSON());
    expect(hasUnsavedContent(NAME)).toBe(false);
    await tracker.afterUnloadDocument({ documentName: NAME });
  });

  it("keeps encoded coverage and unsaved state correct across generated store boundaries", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("none", "encode", "store", "after"), fc.boolean(),
      async (phase, succeeds) => {
        forgetDocument(NAME);
        const doc = seeded();
        const tracker = createChangeTrackingExtension();
        await tracker.afterLoadDocument({ documentName: NAME, document: doc });
        registerDocumentBodyRecords(doc, { contexts: [{ id: "generated-context", dependencies: [] }] });
        const text = source(doc);
        text.insert(1, "AB", { ctx: "generated-context" });
        documentCommentThreads(doc).set("thread", { text: "Preserved", replies: ["Reply"] });
        let snapshot: Uint8Array = new Uint8Array();
        const extension = createPersistenceExtension({
          encode: (current) => {
            if (phase === "encode") text.delete(1, 1);
            return Y.encodeStateAsUpdate(current);
          },
          store: async ({ state }) => {
            snapshot = state;
            if (phase === "store") text.delete(1, 1);
            if (!succeeds) throw new Error("fixture store rejection");
          },
          recordEdit: () => {},
        });
        const arm = armTimedStore(NAME);
        try {
          await extension.onStoreDocument({ documentName: NAME, document: doc });
          if (phase === "after") text.delete(1, 1);
          const stored = restored(snapshot);
          expect(source(stored).toString()).toBe(phase === "encode" ? "B" : "AB");
          expect(documentCommentThreads(stored).toJSON()).toEqual({ thread: { text: "Preserved", replies: ["Reply"] } });
          expect(hasUnsavedContent(NAME)).toBe(!succeeds || phase !== "none");
        } finally {
          releaseTimedStoreArm(NAME, arm);
          await tracker.afterUnloadDocument({ documentName: NAME });
        }
      },
    ), { seed: 16190001, numRuns: 16 });
  });
});
