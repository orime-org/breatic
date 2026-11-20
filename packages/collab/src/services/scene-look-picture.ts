// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Putting a stored part picture on its 3D object (inner#1693 design 6.3).
 *
 * The browser only sent the bytes; the server announced the stored picture
 * with the part the upload started from and the picture that part held then.
 * Collab writes it there when `judgeSceneLookPicture`, the rule the editor
 * shares, allows it. The write runs in the task listener's transaction, so it
 * is in nobody's undo history, as a canvas upload's result is not.
 */

import * as Y from "yjs";
import {
  SCENE_FORMAT_VERSION, SCENE_LOOK_KEY_PREFIX, getSceneRootMap, judgeSceneLookPicture, readSceneRecord,
  type SceneLookPictureEvent, type SceneLookPictureOutcome, type SceneObject,
} from "@breatic/shared";

/**
 * The object as the editor would read it, or undefined when the scene holds no readable one.
 * @param records - The scene's `objects` root.
 * @param id - The object id.
 * @returns The object, or undefined.
 */
function readObject(records: Y.Map<unknown>, id: string): SceneObject | undefined {
  const value = records.get(id);
  // A look and a pose are stored only as flat keys; a whole value under one key is outside the format.
  if (!(value instanceof Y.Map) || value.has("look") || value.has("pose")) return undefined;
  try {
    return readSceneRecord(id, Object.fromEntries(value.entries()));
  } catch {
    return undefined;
  }
}

/**
 * Write the stored picture on its part when it still may go there.
 * @param doc - The 3D Space document, inside the writer's transaction.
 * @param event - The stored picture and where it goes.
 * @returns `write` when written, `done` when the part already holds it, otherwise why nothing was written.
 */
export function applySceneLookPicture(doc: Y.Doc, event: SceneLookPictureEvent): SceneLookPictureOutcome {
  let records: Y.Map<unknown>;
  try {
    if (getSceneRootMap(doc, "scene").get("formatVersion") !== SCENE_FORMAT_VERSION) return "objectGone";
    records = getSceneRootMap(doc, "objects");
  } catch {
    return "objectGone";
  }
  const outcome = judgeSceneLookPicture({
    object: readObject(records, event.objectId), part: event.part, startMap: event.startMap, picture: event.picture,
  });
  if (outcome === "write") {
    (records.get(event.objectId) as Y.Map<unknown>).set(`${SCENE_LOOK_KEY_PREFIX}${event.part}.map`, event.picture);
  }
  return outcome;
}
