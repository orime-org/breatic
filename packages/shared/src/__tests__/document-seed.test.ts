// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Document content seeds contain one empty paragraph; Canvas and Timeline do
 * not use the document body fragment. Timeline receives explicit settings.
 *
 * These tests verify the stored structure. Real-editor fidelity belongs in
 * web: a client can delete an unrecognized seed without a server-side error
 * and broadcast that deletion as an ordinary edit.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import {
  documentBodyFragment,
  encodeInitialSpaceContent,
} from "@shared/document-body.js";

describe("Space content seeds", () => {
  it.each(["canvas", "timeline"] as const)(
    "%s seeds leave the document body fragment empty",
    (kind) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, encodeInitialSpaceContent(kind, kind === "timeline"
        ? { width: 1920, height: 1080, fps: { num: 24, den: 1 } }
        : undefined));
      expect(documentBodyFragment(doc).length).toBe(0);
      doc.destroy();
    },
  );

  it("seeds a document with one block container holding an empty paragraph", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent("document"));
    const fragment = documentBodyFragment(doc);

    // The editor accepts one top-level blockGroup. It would delete a second
    // group and broadcast that deletion to its peers.
    expect(fragment.length).toBe(1);
    const group = fragment.get(0) as Y.XmlElement;
    expect(group.nodeName).toBe("blockGroup");

    // One block holding one empty paragraph.
    expect(group.length).toBe(1);
    const container = group.get(0) as Y.XmlElement;
    expect(container.nodeName).toBe("blockContainer");
    expect(container.getAttribute("id")).toEqual(expect.any(String));

    expect(container.length).toBe(1);
    const paragraph = container.get(0) as Y.XmlElement;
    expect(paragraph.nodeName).toBe("paragraph");
    expect(paragraph.length).toBe(0);

    doc.destroy();
  });

  it("preserves the editor's camel-case node names", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent("document"));
    const group = documentBodyFragment(doc).get(0) as Y.XmlElement;
    const container = group.get(0) as Y.XmlElement;

    // XML serialization lowercases names, so inspect nodeName directly.
    // Lower-case stored names would be unknown to the editor's schema.
    expect([group.nodeName, container.nodeName]).toEqual([
      "blockGroup",
      "blockContainer",
    ]);
  });
});
