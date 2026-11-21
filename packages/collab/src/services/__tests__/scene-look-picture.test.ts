// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What collab does with a stored part picture (inner#1693 design 6.3): the
 * browser only sent the bytes, so collab puts the picture on the part the
 * upload started from when the shared rule allows it, and otherwise writes
 * nothing and says why.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SCENE_FORMAT_VERSION, SCENE_LOOK_MAX_PARTS, type SceneLookPictureEvent } from "@breatic/shared";
import { applySceneLookPicture } from "@collab/services/scene-look-picture.js";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/core", () => ({ createLogger: () => logs }));

const OBJECT = "0b8c7f1a-3e2d-4a5b-8c9d-0e1f2a3b4c5d";
const START = "4b7f3c1e-2d0a-4c6b-9f1e-8a5b2c3d4e5f";
const PICTURE = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const OTHER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const EVENT: SceneLookPictureEvent = {
  type: "scene-look-picture", docName: "project-p/3d-s", objectId: OBJECT, part: "3", startMap: START,
  picture: PICTURE, userId: "u", uploadKey: "k",
};

/**
 * A ready scene holding one model whose stored keys are `stored`.
 * @param stored - Extra keys on the model's record.
 * @returns The document.
 */
function scene(stored: Record<string, unknown> = {}): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("scene").set("formatVersion", SCENE_FORMAT_VERSION);
  const record = new Y.Map<unknown>();
  doc.getMap("objects").set(OBJECT, record);
  record.set("model", { kind: "builtin", id: "figure" });
  for (const [key, value] of Object.entries(stored)) record.set(key, value);
  return doc;
}

/**
 * The part picture the model's record holds.
 * @param doc - The document.
 * @returns The stored `look.3.map`.
 */
function mapOf(doc: Y.Doc): unknown {
  return (doc.getMap("objects").get(OBJECT) as Y.Map<unknown>).get("look.3.map");
}

describe("applySceneLookPicture", () => {
  it("writes the picture on a part that still holds its starting picture", () => {
    const doc = scene({ "look.3.map": START });
    expect(applySceneLookPicture(doc, EVENT)).toBe("write");
    expect(mapOf(doc)).toBe(PICTURE);
  });

  it("writes the picture on a part that was reset meanwhile", () => {
    const doc = scene();
    expect(applySceneLookPicture(doc, EVENT)).toBe("write");
    expect(mapOf(doc)).toBe(PICTURE);
  });

  it("writes nothing more for a picture the part already holds", () => {
    const doc = scene({ "look.3.map": PICTURE });
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    expect(applySceneLookPicture(doc, EVENT)).toBe("done");
    expect(updates).toEqual([]);
  });

  it("writes nothing on a part that now holds another picture", () => {
    const doc = scene({ "look.3.map": OTHER });
    expect(applySceneLookPicture(doc, EVENT)).toBe("partChanged");
    expect(mapOf(doc)).toBe(OTHER);
  });

  it("writes nothing on an object that is gone, locked or no longer readable", () => {
    const gone = scene();
    gone.getMap("objects").delete(OBJECT);
    expect(applySceneLookPicture(gone, EVENT)).toBe("objectGone");
    expect(gone.getMap("objects").size).toBe(0);

    const locked = scene({ locked: true });
    expect(applySceneLookPicture(locked, EVENT)).toBe("objectGone");
    expect(mapOf(locked)).toBeUndefined();

    expect(logs.warn).not.toHaveBeenCalled();
    const broken = scene({ look: { "3": { map: START } } });
    expect(applySceneLookPicture(broken, EVENT)).toBe("objectGone");
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ objectId: OBJECT }), "scene_look_object_unreadable");
  });

  it("writes nothing into a document that is not a ready scene", () => {
    const empty = new Y.Doc();
    expect(applySceneLookPicture(empty, EVENT)).toBe("objectGone");
    expect(empty.getMap("objects").size).toBe(0);
    expect(empty.getMap("scene").size).toBe(0);
  });

  it("writes nothing that would give the object one part more than it may hold", () => {
    const full = Object.fromEntries(Array.from({ length: SCENE_LOOK_MAX_PARTS }, (_, at) => [`look.${at + 10}.color`, "#ff0000"]));
    const doc = scene(full);
    expect(applySceneLookPicture(doc, { ...EVENT, startMap: null })).toBe("partLimit");
    expect(mapOf(doc)).toBeUndefined();
  });
});
