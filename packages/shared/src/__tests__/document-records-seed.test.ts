// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeInitialSpaceContent } from "@shared/document-body.js";

const documents: Y.Doc[] = [];
const histories: Y.UndoManager[] = [];

afterEach(() => {
  for (const history of histories.splice(0)) history.destroy();
  for (const document of documents.splice(0)) document.destroy();
});

/**
 * Decodes production seed bytes into an independently owned peer.
 * @throws {Error} If Yjs rejects the encoded update.
 */
function decodeSeed(bytes: Uint8Array): Y.Doc {
  const document = new Y.Doc();
  documents.push(document);
  Y.applyUpdate(document, bytes);
  return document;
}

describe("document records seed", () => {
  it("seeds a complete records body through the production content encoder", () => {
    const document = decodeSeed(encodeInitialSpaceContent("document"));
    const metadata = document.getMap<unknown>("body:meta");

    expect(metadata.get("format")).toBe("breatic.document.records");
    expect(metadata.get("version")).toBe(1);
    expect(metadata.get("seedRoot")).toEqual(expect.any(String));
    expect(document.getMap("body:records").has(String(metadata.get("seedRoot")))).toBe(true);

    const sources = document.getMap<string>("body:sources");
    expect([...sources.keys()]).toHaveLength(1);
    const sourceId = [...sources.keys()][0]!;
    const text = document.getText(`body:inline:${sourceId}`);
    expect(text.toDelta()).toEqual([
      { insert: { bodyCut: expect.any(String) } },
      { insert: { bodyCut: expect.any(String) } },
    ]);
    expect(text.length).toBe(2);
  });

  it("gives both openers the same registered seed outside their local history", () => {
    const bytes = encodeInitialSpaceContent("document");
    const first = decodeSeed(bytes);
    const second = decodeSeed(bytes);

    for (const document of [first, second]) {
      expect(document.getMap("body:meta").get("format")).toBe("breatic.document.records");
      const history = new Y.UndoManager(document, { trackedOrigins: new Set(["local-user"]) });
      histories.push(history);
      expect(history.undoStack).toEqual([]);
      history.undo();
    }

    for (const key of ["body:meta", "body:records", "body:sources", "body:facts", "body:groups", "body:contexts"]) {
      expect(second.getMap(key).toJSON()).toEqual(first.getMap(key).toJSON());
    }
    for (const id of first.getMap("body:sources").keys()) {
      expect(second.getText(`body:inline:${id}`).toDelta()).toEqual(first.getText(`body:inline:${id}`).toDelta());
    }
    expect(Y.encodeStateAsUpdate(second)).toEqual(Y.encodeStateAsUpdate(first));
  });

  it.each(["canvas", "timeline"] as const)("keeps the empty seed policy for %s", (kind) => {
    const document = decodeSeed(encodeInitialSpaceContent(kind));

    expect([...document.share.keys()]).toEqual([]);
    expect(Y.encodeStateAsUpdate(document)).toEqual(new Uint8Array([0, 0]));
  });
});
