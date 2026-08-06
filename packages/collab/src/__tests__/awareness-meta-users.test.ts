// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit coverage for the awareness-to-meta.users projector.
 *
 * Pins the 4 invariants the `onAwarenessUpdate` hook depends on:
 *   1. Writes the user field into meta.users on first awareness update.
 *   2. Anti-spoof — rejects state where `state.user.id !== context.user.id`.
 *   3. Idempotent name/avatar — no transact when nothing user-fields changed
 *      AND the 30s lastSeenAt debounce window has not elapsed.
 *   4. lastSeenAt refresh after the 30s window even when name/avatar
 *      didn't change (so the bell's "last active N min ago" stays fresh
 *      for users sitting in the project doing nothing but moving the
 *      cursor).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Document } from "@hocuspocus/server";

import {
  __resetAwarenessDebounceState,
  projectAwarenessIntoMetaUsers,
} from "../hooks/awareness-meta-users.js";

const DOC_NAME = "project-pid-1/meta";

interface Fixtures {
  doc: Y.Doc;
  hocuspocusDoc: Document;
  awareness: Awareness;
}

function makeFixtures(): Fixtures {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  // Hocuspocus's `Document` extends `Y.Doc` — for these unit tests
  // we cast the plain Y.Doc back, the projector only uses the
  // Y.Doc surface (`getMap` + `transact`).
  return { doc, hocuspocusDoc: doc as unknown as Document, awareness };
}

beforeEach(() => {
  __resetAwarenessDebounceState();
});

describe("projectAwarenessIntoMetaUsers", () => {
  it("writes the user field on first awareness update", () => {
    const f = makeFixtures();
    f.awareness.setLocalStateField("user", {
      id: "u-yuki",
      name: "Yuki",
      avatarUrl: "https://cdn/yuki.png",
    });
    const localClientId = f.doc.clientID;

    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [localClientId],
      updated: [],
      contextUserId: "u-yuki",
      now: 1_000,
    });

    expect(result.written).toEqual(["u-yuki"]);
    const entry = f.doc.getMap("users").get("u-yuki") as Y.Map<unknown>;
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry.get("name")).toBe("Yuki");
    expect(entry.get("avatarUrl")).toBe("https://cdn/yuki.png");
    expect(entry.get("lastSeenAt")).toBe(1_000);
  });

  it("rejects a state whose user.id differs from contextUserId (anti-spoof)", () => {
    const f = makeFixtures();
    // Malicious client sets a peer's userId in their own awareness.
    f.awareness.setLocalStateField("user", {
      id: "u-victim",
      name: "Spoofed",
      avatarUrl: null,
    });

    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [f.doc.clientID],
      updated: [],
      contextUserId: "u-attacker",
      now: 1_000,
    });

    expect(result.rejected).toEqual(["u-victim"]);
    expect(result.written).toEqual([]);
    expect(f.doc.getMap("users").size).toBe(0);
  });

  it("skips transact when neither user fields changed nor debounce window elapsed", () => {
    const f = makeFixtures();
    f.awareness.setLocalStateField("user", {
      id: "u-yuki",
      name: "Yuki",
      avatarUrl: null,
    });

    // First call lands the entry at lastSeenAt=1000.
    projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [f.doc.clientID],
      updated: [],
      contextUserId: "u-yuki",
      now: 1_000,
    });
    expect(
      (f.doc.getMap("users").get("u-yuki") as Y.Map<unknown>).get("lastSeenAt"),
    ).toBe(1_000);

    // Second call 10s later (same user fields) — must skip the
    // transact: lastSeenAt stays at 1_000, NOT 11_000.
    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [],
      updated: [f.doc.clientID],
      contextUserId: "u-yuki",
      now: 11_000,
    });

    expect(result.skipped).toEqual(["u-yuki"]);
    expect(result.written).toEqual([]);
    expect(
      (f.doc.getMap("users").get("u-yuki") as Y.Map<unknown>).get("lastSeenAt"),
    ).toBe(1_000);
  });

  it("refreshes lastSeenAt past the 30s debounce window", () => {
    const f = makeFixtures();
    f.awareness.setLocalStateField("user", {
      id: "u-yuki",
      name: "Yuki",
      avatarUrl: null,
    });

    projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [f.doc.clientID],
      updated: [],
      contextUserId: "u-yuki",
      now: 1_000,
    });

    // Move past LAST_SEEN_DEBOUNCE_MS (30_000) — refresh fires
    // even though name/avatar are unchanged.
    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [],
      updated: [f.doc.clientID],
      contextUserId: "u-yuki",
      now: 1_000 + 30_001,
    });

    expect(result.written).toEqual(["u-yuki"]);
    expect(
      (f.doc.getMap("users").get("u-yuki") as Y.Map<unknown>).get("lastSeenAt"),
    ).toBe(31_001);
  });

  it("immediately transacts when name changes within the debounce window", () => {
    const f = makeFixtures();
    f.awareness.setLocalStateField("user", {
      id: "u-yuki",
      name: "Yuki Old",
      avatarUrl: null,
    });
    projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [f.doc.clientID],
      updated: [],
      contextUserId: "u-yuki",
      now: 1_000,
    });

    f.awareness.setLocalStateField("user", {
      id: "u-yuki",
      name: "Yuki New",
      avatarUrl: null,
    });
    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [],
      updated: [f.doc.clientID],
      contextUserId: "u-yuki",
      now: 1_100, // well within 30s debounce
    });

    expect(result.written).toEqual(["u-yuki"]);
    const entry = f.doc.getMap("users").get("u-yuki") as Y.Map<unknown>;
    expect(entry.get("name")).toBe("Yuki New");
    expect(entry.get("lastSeenAt")).toBe(1_100);
  });

  it("returns empty result when contextUserId is undefined (no anonymous writes)", () => {
    const f = makeFixtures();
    f.awareness.setLocalStateField("user", {
      id: "u-yuki",
      name: "Yuki",
      avatarUrl: null,
    });

    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [f.doc.clientID],
      updated: [],
      contextUserId: undefined,
      now: 1_000,
    });

    expect(result).toEqual({ written: [], rejected: [], skipped: [] });
    expect(f.doc.getMap("users").size).toBe(0);
  });

  it("skips states that have no `user` field (e.g. cursor-only awareness)", () => {
    const f = makeFixtures();
    f.awareness.setLocalStateField("cursor", { x: 10, y: 20 });

    const result = projectAwarenessIntoMetaUsers({
      documentName: DOC_NAME,
      document: f.hocuspocusDoc,
      awareness: f.awareness,
      added: [f.doc.clientID],
      updated: [],
      contextUserId: "u-yuki",
      now: 1_000,
    });

    expect(result).toEqual({ written: [], rejected: [], skipped: [] });
    expect(f.doc.getMap("users").size).toBe(0);
  });
});
