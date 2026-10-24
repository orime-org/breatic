// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import * as shared from "../index.js";

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
