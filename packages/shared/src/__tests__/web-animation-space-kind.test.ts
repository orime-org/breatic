// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space kind `web_animation` (#1490 design §3.1–§3.3): the type value, its content document name, the
 * pattern that counts its content rows, its empty initial content and its media references.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeInitialSpaceContent } from "../document-body.js";
import { readSpaceMediaReferences } from "../space-media-references.js";
import { SpaceTypeSchema } from "../types/space.js";
import {
  parseDocName, spaceContentDocName, spaceContentRowPattern, webAnimationSpaceDocName,
} from "../yjs-doc-names.js";

const PID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

describe("web_animation Space type", () => {
  it("is a Space type", () => {
    expect(SpaceTypeSchema.parse("web_animation")).toBe("web_animation");
  });

  it("names its content document project-{pid}/web_animation-{sid}", () => {
    expect(webAnimationSpaceDocName(PID, SID)).toBe(`project-${PID}/web_animation-${SID}`);
    expect(spaceContentDocName(PID, SID, "web_animation")).toBe(`project-${PID}/web_animation-${SID}`);
  });

  it("parses its content document name back", () => {
    expect(parseDocName(`project-${PID}/web_animation-${SID}`)).toEqual({ projectId: PID, kind: "web_animation", spaceId: SID });
  });

  it("refuses its kind without a Space id", () => {
    expect(parseDocName(`project-${PID}/web_animation`)).toBeNull();
  });

  it("counts its content row as a Space content row", () => {
    const pattern = new RegExp(spaceContentRowPattern(PID));
    expect(pattern.test(`project-${PID}/web_animation-${SID}`)).toBe(true);
    expect(pattern.test(`project-${PID}/web_animation`)).toBe(false);
  });

  it("starts as an empty document", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent("web_animation"));
    expect([...doc.share.keys()]).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(Y.encodeStateAsUpdate(new Y.Doc()));
  });

  it("references no media, whatever its annotation threads hold", () => {
    const doc = new Y.Doc();
    const thread = new Y.Map<unknown>();
    doc.getMap("webAnimationAnnotationThreads").set("t1", thread);
    thread.set("comments", "https://cdn.example/a.png");
    expect(readSpaceMediaReferences("web_animation", doc)).toEqual({ assetIds: [], urls: [] });
  });
});
