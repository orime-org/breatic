// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * yjs-bootstrap unit tests — verify the binary update produced for a
 * project's initial meta doc decodes back to the expected spaces map.
 *
 * The contract this protects is: when `INSERT INTO yjs_documents`
 * runs with the bytes returned by `encodeInitialMetaState`, the very
 * first Hocuspocus client to load `project-{pid}/meta` must see a
 * single Space entry with all required fields populated. If this
 * test breaks, project creation will appear to succeed but the
 * resulting canvas Space will be invisible to the frontend.
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  defaultSpaceName,
  encodeInitialMetaState,
  encodeInitialSpaceContentState,
  writeSpaceEntry,
} from "../yjs-bootstrap.js";

describe("encodeInitialMetaState", () => {
  it("produces a binary that loads into spaces[spaceId] = entry", () => {
    const spaceId = "11111111-1111-1111-1111-111111111111";
    const userId = "22222222-2222-2222-2222-222222222222";
    const ts = 1_700_000_000_000;

    const update = encodeInitialMetaState({
      spaceId,
      kind: "canvas",
      name: "Untitled",
      createdBy: userId,
      creatorName: "Test Creator",
      creatorAvatarUrl: null,
      ts,
    });

    expect(update).toBeInstanceOf(Uint8Array);
    expect(update.byteLength).toBeGreaterThan(0);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const spaces = doc.getMap("spaces");
    expect(spaces.size).toBe(1);

    const entry = spaces.get(spaceId);
    expect(entry).toBeInstanceOf(Y.Map);
    const entryMap = entry as Y.Map<unknown>;
    expect(entryMap.get("id")).toBe(spaceId);
    expect(entryMap.get("type")).toBe("canvas");
    expect(entryMap.get("name")).toBe("Untitled");
    expect(entryMap.get("order")).toBe(0);
    expect(entryMap.get("locked")).toBe(false);
    expect(entryMap.get("createdAt")).toBe(ts);
    expect(entryMap.get("createdBy")).toBe(userId);
  });

  it("produces deterministic update for the same input", () => {
    const args = {
      spaceId: "11111111-1111-1111-1111-111111111111",
      kind: "canvas" as const,
      name: "Untitled",
      createdBy: "22222222-2222-2222-2222-222222222222",
      creatorName: "Test Creator",
      creatorAvatarUrl: null,
      ts: 1_700_000_000_000,
    };
    const a = encodeInitialMetaState(args);
    const b = encodeInitialMetaState(args);
    // Same input → identical bytes (stable client id makes this true).
    expect(a).toEqual(b);
  });

  it("seeds meta.users[creator] with creator name + avatar + lastSeenAt", () => {
    const userId = "22222222-2222-2222-2222-222222222222";
    const ts = 1_700_000_000_000;
    const update = encodeInitialMetaState({
      spaceId: "11111111-1111-1111-1111-111111111111",
      kind: "canvas",
      name: "Untitled",
      createdBy: userId,
      creatorName: "Yuki",
      creatorAvatarUrl: "https://cdn/yuki.png",
      ts,
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const entry = doc.getMap("users").get(userId) as Y.Map<unknown>;
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry.get("id")).toBe(userId);
    expect(entry.get("name")).toBe("Yuki");
    expect(entry.get("avatarUrl")).toBe("https://cdn/yuki.png");
    expect(entry.get("lastSeenAt")).toBe(ts);
  });

  it("seeds meta.perUser[creator] with first space open + active", () => {
    const spaceId = "11111111-1111-1111-1111-111111111111";
    const userId = "22222222-2222-2222-2222-222222222222";
    const update = encodeInitialMetaState({
      spaceId,
      kind: "canvas",
      name: "Untitled",
      createdBy: userId,
      creatorName: "Yuki",
      creatorAvatarUrl: null,
      ts: 1_700_000_000_000,
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const entry = doc.getMap("perUser").get(userId) as Y.Map<unknown>;
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry.get("activeSpaceId")).toBe(spaceId);
    const openTabIds = entry.get("openTabIds") as Y.Array<string>;
    expect(openTabIds.toArray()).toEqual([spaceId]);
  });

  it("supports document and timeline kinds", () => {
    const base = {
      spaceId: "11111111-1111-1111-1111-111111111111",
      name: "Untitled",
      createdBy: "22222222-2222-2222-2222-222222222222",
      creatorName: "Test Creator",
      creatorAvatarUrl: null,
      ts: 1_700_000_000_000,
    };
    for (const kind of ["document", "timeline"] as const) {
      const update = encodeInitialMetaState({ ...base, kind });
      const doc = new Y.Doc();
      Y.applyUpdate(doc, update);
      const entry = doc.getMap("spaces").get(base.spaceId) as Y.Map<unknown>;
      expect(entry.get("type")).toBe(kind);
    }
  });
});

describe("writeSpaceEntry (shared Space-entry construction)", () => {
  it("inserts one Space entry carrying the canonical field shape", () => {
    const doc = new Y.Doc();
    const spaces = doc.getMap("spaces");
    writeSpaceEntry(spaces, {
      spaceId: "s-1",
      type: "document",
      name: "Doc",
      order: 2,
      createdAt: 123,
      createdBy: "u-1",
    });
    expect(spaces.size).toBe(1);
    const e = spaces.get("s-1") as Y.Map<unknown>;
    expect(e.get("id")).toBe("s-1");
    expect(e.get("type")).toBe("document");
    expect(e.get("name")).toBe("Doc");
    expect(e.get("order")).toBe(2);
    expect(e.get("locked")).toBe(false);
    expect(e.get("createdAt")).toBe(123);
    expect(e.get("createdBy")).toBe("u-1");
  });

  it("builds the FIRST Space (bootstrap seed) with the same field shape as a later Space, claim token aside", () => {
    // The "one logic" invariant: encodeInitialMetaState's first Space and
    // any later Space (collab space:create) are constructed by the SAME
    // writeSpaceEntry, so their field keys must be identical.
    //
    // `claimToken` is the one key that legitimately differs, and the later
    // Space below carries one so this compares the shapes that actually
    // occur rather than two token-less entries. A Space created through
    // the RPC always has a token (a client asked for it); the seeded first
    // Space never does (the server made it with nobody waiting). Every
    // OTHER key must still match, which is what this pins.
    const seededDoc = new Y.Doc();
    Y.applyUpdate(
      seededDoc,
      encodeInitialMetaState({
        spaceId: "s-first",
        kind: "canvas",
        name: "Canvas",
        createdBy: "u",
        creatorName: "U",
        creatorAvatarUrl: null,
        ts: 1,
      }),
    );
    const seededKeys = Object.keys(
      (seededDoc.getMap("spaces").get("s-first") as Y.Map<unknown>).toJSON(),
    ).sort();

    const laterDoc = new Y.Doc();
    writeSpaceEntry(laterDoc.getMap("spaces"), {
      spaceId: "s-later",
      type: "canvas",
      name: "Canvas 2",
      order: 1,
      createdAt: 2,
      createdBy: "u2",
      claimToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    const laterKeys = Object.keys(
      (laterDoc.getMap("spaces").get("s-later") as Y.Map<unknown>).toJSON(),
    )
      .filter((k) => k !== "claimToken")
      .sort();

    expect(laterKeys).toContain("createdBy");
    expect(seededKeys).toEqual(laterKeys);
  });

  // ── Task #27: the claim token rides on the entry ──────────────────────
  //
  // The server mints the id now, so the machine that asked for a Space no
  // longer knows what to look for in the broadcast. The token it sent is
  // written onto the entry and comes back with it, and only that machine
  // recognises it. The server stores it and never parses it.

  it("writes the claim token onto the entry when one was supplied", () => {
    const doc = new Y.Doc();
    const spaces = doc.getMap("spaces");
    writeSpaceEntry(spaces, {
      spaceId: "s-1",
      type: "canvas",
      name: "Main",
      order: 0,
      createdAt: 1,
      createdBy: "u-1",
      claimToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });
    const e = spaces.get("s-1") as Y.Map<unknown>;
    expect(e.get("claimToken")).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  });

  it("omits the key entirely when there is no claim token", () => {
    // The first Space of a project is seeded by the server with no client
    // waiting on it. Storing an explicit `undefined` would put a key with
    // no meaning into a permanently shared document, and it would travel
    // into the delete snapshot and back out on restore. Absent means
    // absent.
    const doc = new Y.Doc();
    const spaces = doc.getMap("spaces");
    writeSpaceEntry(spaces, {
      spaceId: "s-1",
      type: "canvas",
      name: "Main",
      order: 0,
      createdAt: 1,
      createdBy: "u-1",
    });
    const e = spaces.get("s-1") as Y.Map<unknown>;
    expect(e.has("claimToken")).toBe(false);
    expect(Object.keys(e.toJSON())).not.toContain("claimToken");
  });
});

describe("encodeInitialSpaceContentState (blank Space content doc seed)", () => {
  it("encodes an EMPTY Yjs doc (a blank Space — editor builds structure on bind)", () => {
    const update = encodeInitialSpaceContentState();
    expect(update).toBeInstanceOf(Uint8Array);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    // No top-level shared types: the canvas/document/timeline editor
    // creates its own structure (nodes/edges, XmlFragment, …) on first
    // bind. The seed only makes the content-doc row EXIST.
    expect(doc.share.size).toBe(0);
  });

  it("is type-independent — the doc NAME carries the type, the content is the same empty doc", () => {
    // Two calls produce equivalent empty content regardless of which
    // Space type they back; only spaceContentDocName differs by type.
    const a = encodeInitialSpaceContentState();
    const b = encodeInitialSpaceContentState();
    expect(a).toEqual(b);
  });
});

describe("defaultSpaceName", () => {
  it("maps each Space kind to its default English name", () => {
    expect(defaultSpaceName("canvas")).toBe("Canvas");
    expect(defaultSpaceName("document")).toBe("Document");
    expect(defaultSpaceName("timeline")).toBe("Timeline");
  });
});
