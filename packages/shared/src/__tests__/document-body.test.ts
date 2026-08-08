// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the encoder puts in a fresh Space's content document.
 *
 * The shape matters, not just the count. The backend writes these bytes
 * without going through ProseMirror, and the editor does not complain about a
 * node it does not recognise — it quietly deletes it on bind and broadcasts
 * that deletion as its own edit. So a heading, or a paragraph carrying an
 * attribute the schema has never heard of, would ship as silently as a correct
 * one. "At least one block" is true of all three.
 *
 * The other end of this contract runs the real editor over these same bytes:
 * `web/spaces/document/__tests__/backend-seed-contract.test.ts`.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";

import {
  documentBodyFragment,
  encodeInitialSpaceContent,
} from "@shared/document-body.js";

/**
 * Decode an encoded initial state so its contents can be read.
 * @param update - The encoded update.
 * @returns A Y.Doc holding that state.
 */
function decode(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return doc;
}

describe("encodeInitialSpaceContent", () => {
  it("gives a document exactly one empty paragraph, with no attributes", () => {
    const body = documentBodyFragment(decode(encodeInitialSpaceContent("document")));
    expect(body.length).toBe(1);
    const first = body.get(0) as Y.XmlElement;
    expect(first.nodeName).toBe("paragraph");
    expect(first.length).toBe(0);
    expect(first.getAttributes()).toEqual({});
  });

  it("leaves a canvas with nothing — its editor builds its own structure", () => {
    expect(decode(encodeInitialSpaceContent("canvas")).share.size).toBe(0);
  });

  it("leaves a timeline with nothing, for the same reason", () => {
    expect(decode(encodeInitialSpaceContent("timeline")).share.size).toBe(0);
  });

  it("puts the body under the key the editor binds to", () => {
    // Read through the accessor rather than naming the key here. A second
    // place naming it is a second place that can drift, which is why the key
    // itself is not exported.
    const doc = decode(encodeInitialSpaceContent("document"));
    expect(documentBodyFragment(doc).length).toBe(1);
  });

  it("does not pin the client id — two encodes are independent writers", () => {
    // Pinning it would make seeds from two releases merge into one block
    // rather than two, with which one survives decided by arrival order and
    // both sides believing they had the whole story. Two blocks is visible
    // and fixable; a silent divergence is neither.
    const a = decode(encodeInitialSpaceContent("document"));
    const b = decode(encodeInitialSpaceContent("document"));
    expect(a.clientID).not.toBe(b.clientID);
  });
});
