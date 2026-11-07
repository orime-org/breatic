// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * `updateShape` read against a real yjs struct store, the one function collab's
 * gate and web's undo trial both judge an update with (inner#1790 v2 spec
 * SH-01 to SH-16).
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { updateShape } from "@shared/doc-size.js";

/** A client document and a server copy kept in step by applying every update. */
function pair(clientID: number): { client: Y.Doc; server: Y.Doc } {
  const client = new Y.Doc();
  client.clientID = clientID;
  const server = new Y.Doc();
  client.on("update", (u: Uint8Array) => Y.applyUpdate(server, u));
  return { client, server };
}

/**
 * Run one change on the client and return its update with the server store as
 * it was before the update arrived.
 */
function capture(client: Y.Doc, server: Y.Doc, change: () => void): { update: Uint8Array; store: Y.Doc["store"]; doc: Y.Doc } {
  const before = new Y.Doc();
  Y.applyUpdate(before, Y.encodeStateAsUpdate(server));
  let update: Uint8Array | null = null;
  const take = (u: Uint8Array): void => { update = u; };
  client.on("update", take);
  client.transact(change);
  client.off("update", take);
  if (update === null) throw new Error("the change wrote nothing");
  return { update, store: before.store, doc: before };
}

/** The node fixture of spec 0.3: data map, body fragment, renamed twice. */
function nodeDoc(): { client: Y.Doc; server: Y.Doc; node: Y.Map<unknown>; data: Y.Map<unknown>; focus: Y.Array<string>; text: Y.XmlText; paragraph: Y.XmlElement } {
  const { client, server } = pair(7);
  const nodes = client.getMap<Y.Map<unknown>>("nodes");
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  const focus = new Y.Array<string>();
  const body = new Y.XmlFragment();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  client.transact(() => {
    nodes.set("n1", node);
    node.set("data", data);
    data.set("locked", true);
    data.set("color", "red");
    data.set("focus", focus);
    node.set("body", body);
    body.insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, "hello world");
  });
  focus.push(["a"]);
  focus.push(["b"]);
  focus.push(["c"]);
  node.set("name", "x1");
  node.set("name", "x2");
  return { client, server, node, data, focus, text, paragraph };
}

/** lib0 varuint: seven bits per byte, low bits first. */
function varUint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** A pure-delete update written by hand in the v1 encoding: no structs, one client, one range. */
function beyondDs(client: number, clock: number, len: number): Uint8Array {
  return new Uint8Array([0, 1, ...varUint(client), 1, ...varUint(clock), ...varUint(len)]);
}

/** The alt2000 fixture of spec 0.3: one root text holding 2000 characters inserted at once. */
function alt2000(clientID: number): { client: Y.Doc; server: Y.Doc; t: Y.Text } {
  const { client, server } = pair(clientID);
  const t = client.getText("t");
  t.insert(0, "x".repeat(2000));
  return { client, server, t };
}

describe("updateShape", () => {
  it("SH-01 deleting a whole node is a pure delete of whole types with no struct bytes", () => {
    const { client, server } = nodeDoc();
    const { update, store } = capture(client, server, () => client.getMap("nodes").delete("n1"));
    expect(updateShape(update, store)).toEqual({ pureDelete: true, structBytes: 0, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
  });

  it("SH-02 deleting one Map entry holding a plain value counts as a whole entry", () => {
    const { client, server, data } = nodeDoc();
    const { update, store } = capture(client, server, () => data.delete("locked"));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
  });

  it("SH-03 deleting part of a text splits the item at both ends and is not a whole type", () => {
    const { client, server, text } = nodeDoc();
    const { update, store } = capture(client, server, () => text.delete(2, 3));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 2, beyondClockRanges: 0, wholeTypesOnly: false });
  });

  it("SH-04 deleting the middle item of a plain-value array is not a whole type", () => {
    const { client, server, focus } = nodeDoc();
    const { update, store } = capture(client, server, () => focus.delete(1, 1));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 2, wholeTypesOnly: false });
  });

  it("SH-05 deleting every other character of 2000 counts 1999 split endpoints", () => {
    const { client, server, t } = alt2000(11);
    const { update, store } = capture(client, server, () => {
      for (let i = 1999; i >= 1; i -= 2) t.delete(i, 1);
    });
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 1999, wholeTypesOnly: false });
  });

  it("SH-06 a range starting at the item start splits only at its end", () => {
    const { client, server, t } = alt2000(11);
    const inner = capture(client, server, () => {
      for (let i = 1024; i >= 2; i -= 2) t.delete(i, 1);
    });
    expect(updateShape(inner.update, inner.store).splitEndpoints).toBe(1024);
    const { client: c2, server: s2, t: t2 } = alt2000(11);
    const withStart = capture(c2, s2, () => {
      for (let i = 1024; i >= 2; i -= 2) t2.delete(i, 1);
      t2.delete(0, 1);
    });
    expect(updateShape(withStart.update, withStart.store).splitEndpoints).toBe(1025);
  });

  it("SH-07 deleting all the text of a root text is not a whole type", () => {
    const { client, server, t } = alt2000(11);
    const { update, store } = capture(client, server, () => t.delete(0, 2000));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, wholeTypesOnly: false });
  });

  it("SH-08 a delete range of an unknown client is beyond the clock", () => {
    const server = new Y.Doc();
    expect(updateShape(beyondDs(4242, 100, 1), server.store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 1 });
  });

  it("SH-09 a range ending past the server's clock of that client is beyond the clock", () => {
    const { server } = nodeDoc();
    const state = Y.getState(server.store, 7);
    expect(updateShape(beyondDs(7, state - 2, 5), server.store).beyondClockRanges).toBe(1);
  });

  it("SH-10 a handshake delete set covering only deleted content is whole-types-only", () => {
    const { client, server } = nodeDoc();
    client.getMap("nodes").delete("n1");
    const step2 = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(updateShape(step2, server.store)).toEqual({ pureDelete: true, structBytes: 0, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
  });

  it("SH-11 a delete together with a write is not a pure delete", () => {
    const { client, server, data, node } = nodeDoc();
    const { update, store } = capture(client, server, () => {
      data.delete("color");
      node.set("name", "x3");
    });
    expect(updateShape(update, store).pureDelete).toBe(false);
  });

  it("SH-12 an insert-only update counts its length less the empty delete set", () => {
    const { client, server } = pair(7);
    const { update, store } = capture(client, server, () => {
      const n2 = new Y.Map<unknown>();
      client.getMap("nodes").set("n2", n2);
      n2.set("name", "abc");
    });
    expect(updateShape(update, store)).toEqual({ pureDelete: false, structBytes: update.byteLength - 1, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
  });

  it("SH-13 removing an XML attribute counts as deleting a Map entry", () => {
    const { client, server, paragraph } = nodeDoc();
    paragraph.setAttribute("id", "b1");
    const { update, store } = capture(client, server, () => paragraph.removeAttribute("id"));
    expect(updateShape(update, store)).toMatchObject({ pureDelete: true, wholeTypesOnly: true });
  });

  it("SH-14 already-deleted items in the delete set take no part in the judgement", () => {
    const { client, server, data } = nodeDoc();
    const { store } = capture(client, server, () => data.delete("color"));
    // The client's whole delete set now covers the overwritten "x1" name item and the live "color" entry.
    const withOld = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(updateShape(withOld, store)).toEqual({ pureDelete: true, structBytes: 0, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
  });

  it("SH-15 a malformed update throws", () => {
    expect(() => updateShape(new Uint8Array([1]), new Y.Doc().store)).toThrow(/Unexpected end of array/);
    expect(() => updateShape(new Uint8Array([0, 1, 5]), new Y.Doc().store)).toThrow(/Unexpected end of array/);
  });

  it("SH-16 reading leaves the store unchanged and gives the same answer twice", () => {
    const { client, server, text } = nodeDoc();
    const { update, store, doc } = capture(client, server, () => text.delete(2, 3));
    const snapshot = Y.encodeStateAsUpdate(doc);
    const first = updateShape(update, store);
    const second = updateShape(update, store);
    expect(second).toEqual(first);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(snapshot);
    expect(store.pendingStructs).toBeNull();
    expect(store.pendingDs).toBeNull();
  });
});
