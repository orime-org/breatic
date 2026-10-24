// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import * as shared from "../index.js";

type RootShape = "text" | "array" | "mixed";
const fixtureDocuments: Y.Doc[] = [];
const incompatibleRoots = ["scene", "objects"].flatMap((root) =>
  (["text", "array", "mixed"] as const).flatMap((shape) =>
    [false, true].map((encoded) => ({ root, shape, encoded })),
  ),
);

/** Creates real incompatible root content, optionally restored without binding its root type. */
function incompatibleDocument(root: string, shape: RootShape, encoded: boolean): Y.Doc {
  const source = new Y.Doc();
  fixtureDocuments.push(source);
  if (root === "objects") source.getMap("scene").set("formatVersion", 1);
  if (shape === "text") source.getText(root).insert(0, "incompatible root");
  else if (shape === "array") source.getArray(root).push(["incompatible root", 17]);
  else {
    source.getMap(root).set(root === "scene" ? "formatVersion" : "retained", root === "scene" ? 1 : true);
    const peer = new Y.Doc();
    fixtureDocuments.push(peer);
    peer.getText(root).insert(0, "sequence merged into map");
    Y.applyUpdate(source, Y.encodeStateAsUpdate(peer));
  }
  if (!encoded) return source;
  const restored = new Y.Doc();
  fixtureDocuments.push(restored);
  Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
  return restored;
}

afterEach(() => {
  for (const doc of fixtureDocuments.splice(0)) doc.destroy();
});

/**
 * Initializes through the public API while keeping missing APIs in test assertions.
 * @throws {AssertionError} When the public initializer is not exported.
 */
function initialize(doc: Y.Doc): void {
  const candidate = (shared as unknown as Record<string, unknown>).initializeSceneDocument;
  expect(typeof candidate, "initializeSceneDocument must be exported from shared").toBe("function");
  (candidate as (document: Y.Doc) => void)(doc);
}

describe("scene document initialization", () => {
  it("seeds version one and exactly the two scene roots", () => {
    const doc = new Y.Doc();
    initialize(doc);
    expect((shared as unknown as Record<string, unknown>).SCENE_FORMAT_VERSION).toBe(1);
    expect([...doc.share.keys()].sort()).toEqual(["objects", "scene"]);
    expect(doc.getMap("scene").toJSON()).toEqual({ formatVersion: 1 });
    expect(doc.getMap("objects").toJSON()).toEqual({});
    doc.destroy();
  });

  it("round-trips the initialized format through a Yjs update", () => {
    const source = new Y.Doc();
    initialize(source);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(source));
    initialize(restored);
    expect(restored.getMap("scene").toJSON()).toEqual({ formatVersion: 1 });
    expect(restored.getMap("objects").toJSON()).toEqual({});
    expect([...restored.share.keys()].sort()).toEqual(["objects", "scene"]);
    source.destroy(); restored.destroy();
  });

  it.each(incompatibleRoots)(
    "rejects $root $shape root content with encoded=$encoded and preserves its bytes", ({ root, shape, encoded }) => {
      const doc = incompatibleDocument(root, shape, encoded);
      const before = Y.encodeStateAsUpdate(doc);
      expect(() => initialize(doc)).toThrow(Error);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    },
  );

  it("does not change initialized data or bytes when called again", () => {
    const doc = new Y.Doc();
    initialize(doc);
    doc.getMap("objects").set("existing", { damaged: true });
    const bytes = Y.encodeStateAsUpdate(doc);
    initialize(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(doc.getMap("objects").toJSON()).toEqual({ existing: { damaged: true } });
    doc.destroy();
  });

  it("preserves unknown version metadata and object bytes", () => {
    const doc = new Y.Doc();
    doc.getMap("scene").set("formatVersion", 99);
    doc.getMap("scene").set("futureField", "retained");
    doc.getMap("objects").set("futureObject", { futureField: true });
    const bytes = Y.encodeStateAsUpdate(doc);
    initialize(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(doc.getMap("scene").toJSON()).toEqual({ formatVersion: 99, futureField: "retained" });
    expect(doc.getMap("objects").toJSON()).toEqual({ futureObject: { futureField: true } });
    doc.destroy();
  });

  it.each(["scene", "objects"])("preserves existing %s content with missing version metadata", (root) => {
    const doc = new Y.Doc();
    doc.getMap(root).set("existing", true);
    const bytes = Y.encodeStateAsUpdate(doc);
    initialize(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(doc.getMap(root).toJSON()).toEqual({ existing: true });
    doc.destroy();
  });

  it("keeps independently initialized Space documents separate", () => {
    const left = new Y.Doc(); const right = new Y.Doc();
    initialize(left); initialize(right);
    left.getMap("objects").set("left", { name: "Left" });
    expect(left.getMap("objects").toJSON()).toEqual({ left: { name: "Left" } });
    expect(right.getMap("objects").toJSON()).toEqual({});
    expect(right.getMap("scene").toJSON()).toEqual({ formatVersion: 1 });
    left.destroy(); right.destroy();
  });
});
