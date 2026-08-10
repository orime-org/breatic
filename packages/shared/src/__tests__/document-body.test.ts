// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the encoder puts in a fresh Space's content document.
 *
 * The shape matters, not just the count. The backend writes these bytes
 * without going through ProseMirror, and the editor does not complain about a
 * node it does not recognise — it quietly deletes it on bind and broadcasts
 * that deletion as its own edit. So a heading, or a title carrying an
 * attribute the schema has never heard of, would ship as silently as a correct
 * one.
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
  it("gives a document one title block and nothing else", () => {
    const body = documentBodyFragment(
      decode(encodeInitialSpaceContent("document", "Storyboard v3")),
    );
    // One block, not two: no seeded paragraph. The body below the title is
    // allowed to hold nothing, so there is nothing to seed it with.
    expect(body.length).toBe(1);
    const title = body.get(0) as Y.XmlElement;
    expect(title.nodeName).toBe("title");
    expect(title.toString()).toBe("<title>Storyboard v3</title>");
    expect(title.getAttributes()).toEqual({});
  });

  it("takes the name a project's first Space is given, same as any other", () => {
    // That path has no name its creator typed; the one it has comes from the
    // Space type. It is still the name on the Space's tab, so it is still the
    // document's title — there is no second rule for this path.
    const body = documentBodyFragment(
      decode(encodeInitialSpaceContent("document", "Document")),
    );
    expect(body.length).toBe(1);
    expect((body.get(0) as Y.XmlElement).toString()).toBe(
      "<title>Document</title>",
    );
  });

  it("leaves a canvas with nothing — its editor builds its own structure", () => {
    // The name is still passed; a canvas has one too. It just has nowhere to
    // put it, and must not invent a structure its editor never heard of.
    expect(decode(encodeInitialSpaceContent("canvas", "Canvas")).share.size).toBe(0);
  });

  it("leaves a timeline with nothing, for the same reason", () => {
    expect(decode(encodeInitialSpaceContent("timeline", "Timeline")).share.size).toBe(0);
  });

  it("does not pin the client id — two encodes are independent writers", () => {
    // Pinning it would make seeds from two releases merge into one block
    // rather than two, with which one survives decided by arrival order and
    // both sides believing they had the whole story. Two blocks is visible
    // and fixable; a silent divergence is neither.
    const a = decode(encodeInitialSpaceContent("document", "x"));
    const b = decode(encodeInitialSpaceContent("document", "x"));
    expect(a.clientID).not.toBe(b.clientID);
  });
});
