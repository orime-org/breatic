// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one append into a node's focus pool (#1782, #1580), run by collab when a crop's upload is registered: it keeps
 * the pool a CRDT sequence, never writes an entry the readers would drop, and adds each id once.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { appendFocusImageCore } from "@shared/canvas/focus-image-append.js";
import { MAX_FOCUS_ENTRIES, validFocusImages } from "@shared/canvas/focus-images.js";
import type { FocusImage } from "@shared/types/canvas-node.js";

/**
 * A crop.
 * @param id - Its id.
 * @returns The image.
 */
function crop(id: string): FocusImage {
  return { id, url: `https://cdn.test/${id}.png`, name: `Crop ${id}`, width: 100, height: 100 };
}

/**
 * A node's data map, attached to a document, with an optional pool.
 * @param pool - The pool value to seed, if any.
 * @returns The map.
 */
function nodeData(pool?: unknown): Y.Map<unknown> {
  const doc = new Y.Doc();
  const data = doc.getMap<unknown>("data");
  if (pool !== undefined) doc.transact(() => data.set("focusImages", pool));
  return data;
}

/**
 * The pool as plain values.
 * @param data - The node's data map.
 * @returns Its entries.
 */
function poolOf(data: Y.Map<unknown>): unknown[] {
  const raw = data.get("focusImages");
  return raw instanceof Y.Array ? raw.toArray() : (raw as unknown[]);
}

describe("appendFocusImageCore", () => {
  it("appends in order into the CRDT sequence", () => {
    const arr = new Y.Array<unknown>();
    const data = nodeData(arr);
    data.doc!.transact(() => {
      expect(appendFocusImageCore(data, crop("a"))).toBe("added");
      expect(appendFocusImageCore(data, crop("b"))).toBe("added");
    });
    expect(data.get("focusImages")).toBe(arr);
    expect(poolOf(data)).toEqual([crop("a"), crop("b")]);
  });

  it("creates the sequence on a node with no pool", () => {
    const data = nodeData();
    data.doc!.transact(() => appendFocusImageCore(data, crop("a")));
    expect(data.get("focusImages")).toBeInstanceOf(Y.Array);
    expect(poolOf(data)).toEqual([crop("a")]);
  });

  it("converts a legacy plain array into the sequence, keeping only its valid entries", () => {
    const data = nodeData([crop("a"), null]);
    data.doc!.transact(() => appendFocusImageCore(data, crop("b")));
    expect(data.get("focusImages")).toBeInstanceOf(Y.Array);
    expect(poolOf(data)).toEqual([crop("a"), crop("b")]);
  });

  it("appends past malformed remote entries, which the readers drop", () => {
    const arr = new Y.Array<unknown>();
    const data = nodeData(arr);
    data.doc!.transact(() => arr.push([null, crop("a")]));
    data.doc!.transact(() => appendFocusImageCore(data, crop("b")));
    expect(validFocusImages(poolOf(data))).toEqual([crop("a"), crop("b")]);
  });

  it("refuses an image the readers would drop, writing nothing", () => {
    const data = nodeData(new Y.Array<unknown>());
    data.doc!.transact(() => {
      expect(appendFocusImageCore(data, { ...crop("a"), name: "x".repeat(301) })).toBe("invalid-entry");
      expect(appendFocusImageCore(data, { ...crop("a"), width: 0 })).toBe("invalid-entry");
    });
    expect(poolOf(data)).toEqual([]);
  });

  it("adds an id the pool already holds only once", () => {
    const data = nodeData(new Y.Array<unknown>());
    data.doc!.transact(() => {
      appendFocusImageCore(data, crop("a"));
      expect(appendFocusImageCore(data, { ...crop("a"), url: "https://cdn.test/other.png" })).toBe("duplicate");
    });
    expect(poolOf(data)).toEqual([crop("a")]);
  });

  it("refuses past the entry ceiling", () => {
    const arr = new Y.Array<unknown>();
    const data = nodeData(arr);
    data.doc!.transact(() => arr.push(Array.from({ length: MAX_FOCUS_ENTRIES }, (_, i) => crop(`k${i}`))));
    let outcome = "";
    data.doc!.transact(() => {
      outcome = appendFocusImageCore(data, crop("over"));
    });
    expect(outcome).toBe("pool-full");
    expect(poolOf(data)).toHaveLength(MAX_FOCUS_ENTRIES);
  });

  it("keeps two crops added at once on two replicas", () => {
    const base = new Y.Doc();
    const baseData = base.getMap<unknown>("data");
    base.transact(() => baseData.set("focusImages", new Y.Array<unknown>()));
    const [a, b] = [new Y.Doc(), new Y.Doc()];
    Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(base));
    a.transact(() => appendFocusImageCore(a.getMap<unknown>("data"), crop("a")));
    b.transact(() => appendFocusImageCore(b.getMap<unknown>("data"), crop("b")));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ids = (d: Y.Doc): string[] => (poolOf(d.getMap<unknown>("data")) as FocusImage[]).map((f) => f.id).sort();
    expect(ids(a)).toEqual(["a", "b"]);
    expect(ids(b)).toEqual(["a", "b"]);
  });
});
