// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where an uploaded part picture lands (inner#1693 design 6.3): the browser
 * only sends the bytes, the server announces the stored picture and collab
 * writes it onto the part the upload started from, judged by one function
 * both sides share.
 */

import { describe, expect, it } from "vitest";

import * as shared from "../index.js";

const ID = "0b8c7f1a-3e2d-4a5b-8c9d-0e1f2a3b4c5d";
const START = "4b7f3c1e-2d0a-4c6b-9f1e-8a5b2c3d4e5f";
const PICTURE = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const OTHER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const MODEL = {
  name: "Figure", model: { kind: "builtin", id: "figure" },
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false,
};

/**
 * Read a stored record.
 * @param stored - The record's flat keys.
 * @returns The object it reads as.
 */
function object(stored: Record<string, unknown>): shared.SceneObject {
  return shared.readSceneRecord(ID, { ...MODEL, ...stored });
}

/**
 * Judge one picture write.
 * @param target - The object, or undefined when it is gone.
 * @param startMap - The part's picture when the upload started.
 * @returns The outcome.
 */
function judge(target: shared.SceneObject | undefined, startMap: string | null): shared.SceneLookPictureOutcome {
  return shared.judgeSceneLookPicture({ object: target, part: "3", startMap, picture: PICTURE });
}

describe("readSceneRecord", () => {
  it("reads flat look keys into the object's look and fills missing editable keys", () => {
    const read = shared.readSceneRecord(ID, { model: { kind: "builtin", id: "figure" }, "look.3.map": START });
    expect(read.look).toEqual({ "3": { map: START } });
    expect(read.locked).toBe(false);
    expect(read.name).toBe("figure");
  });

  it("throws for a record outside the format", () => {
    expect(() => shared.readSceneRecord(ID, { ...MODEL, "look.3.map": 12 })).toThrow();
  });
});

describe("judgeSceneLookPicture", () => {
  it("writes when the part still holds the picture the upload started from", () => {
    expect(judge(object({ "look.3.map": START }), START)).toBe("write");
  });

  it("writes when the part has no picture, whether it had none at the start or was reset meanwhile", () => {
    expect(judge(object({}), null)).toBe("write");
    expect(judge(object({}), START)).toBe("write");
  });

  it("is done when the part already holds this picture", () => {
    expect(judge(object({ "look.3.map": PICTURE }), START)).toBe("done");
  });

  it("refuses a part that now holds another picture or has its own picture turned off", () => {
    expect(judge(object({ "look.3.map": OTHER }), START)).toBe("partChanged");
    expect(judge(object({ "look.3.map": "none" }), null)).toBe("partChanged");
  });

  it("refuses an object that is gone, locked or not a model", () => {
    expect(judge(undefined, null)).toBe("objectGone");
    expect(judge(object({ locked: true }), null)).toBe("objectGone");
    const camera = shared.readSceneRecord(ID, { ...MODEL, name: "Camera 1", model: { kind: "camera" }, number: 1 });
    expect(judge(camera, null)).toBe("objectGone");
  });

  it("refuses a new part past the part limit and writes a part the look already has", () => {
    const full = Object.fromEntries(Array.from({ length: shared.SCENE_LOOK_MAX_PARTS }, (_, at) => [`look.${at + 10}.color`, "#ff0000"]));
    expect(judge(object(full), null)).toBe("partLimit");
    expect(shared.judgeSceneLookPicture({ object: object(full), part: "10", startMap: null, picture: PICTURE })).toBe("write");
  });
});
