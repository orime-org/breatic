// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeInitialSpaceContent } from "../../document-body.js";
import { readTimelineDocument } from "../document.js";

const SETTINGS = { width: 2560, height: 1440, fps: { num: 30000, den: 1001 } };

describe("Timeline content seeds", () => {
  it("encodes complete V1 content using the creation settings supplied by the service", () => {
    const document = new Y.Doc();
    try {
      Y.applyUpdate(document, encodeInitialSpaceContent("timeline", SETTINGS));
      expect(readTimelineDocument(document)).toEqual({
        schemaVersion: 1,
        settings: SETTINGS,
        tracks: { "visual-1": { id: "visual-1", kind: "visual", order: 0 } },
        clips: {},
        sources: {},
        nativeEdits: {},
      });
    } finally {
      document.destroy();
    }
  });

  it("leaves concurrent first readers with the same single seeded track", () => {
    const bytes = encodeInitialSpaceContent("timeline", SETTINGS);
    const first = new Y.Doc();
    const second = new Y.Doc();
    try {
      Y.applyUpdate(first, bytes);
      Y.applyUpdate(second, bytes);
      Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
      Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
      expect(readTimelineDocument(first).tracks).toEqual({
        "visual-1": { id: "visual-1", kind: "visual", order: 0 },
      });
      expect(readTimelineDocument(second)).toEqual(readTimelineDocument(first));
      expect(readTimelineDocument(second).settings).toEqual(SETTINGS);
    } finally {
      first.destroy();
      second.destroy();
    }
  });

  it("requires explicit Timeline settings instead of choosing shared runtime defaults", () => {
    expect(() => encodeInitialSpaceContent("timeline")).toThrow(Error);
  });
});
