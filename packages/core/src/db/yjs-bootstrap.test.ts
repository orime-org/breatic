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
import { encodeInitialMetaState } from "./yjs-bootstrap.js";

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
      actor: "test-actor",
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
      actor: "test-actor",
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
      actor: userId,
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
      actor: userId,
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
      actor: "test-actor",
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
