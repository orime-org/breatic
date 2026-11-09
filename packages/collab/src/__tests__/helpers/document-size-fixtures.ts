// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Document and update builders for the document size cap tests (inner#1790,
 * second version). Each builder follows the construction table of the v2
 * collab test spec (section 0.3) so a case citing a shape gets the bytes the
 * spec's measured values came from.
 *
 * Nothing here computes a judgement the production code makes: `cost` is the
 * design 4.1 formula (the message length plus `C` per event) over the
 * production `updateShape` result, and `enc` is the encoded size the design
 * names as the exact measure.
 */

import { DOC_SIZE_EVENT_BYTES, updateShape } from "@breatic/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/** The spec's `C`, read from the shared contract. */
export const C: number = DOC_SIZE_EVENT_BYTES;

/** Spec 0.2 configuration D (the repository defaults). */
export const D_CONFIG = Object.freeze({
  max_document_bytes: 10_485_760,
  document_size_warn_ratio: 0.9,
  document_size_delete_headroom_bytes: 262_144,
  document_size_max_delete_splits: 1024,
  document_size_measure_interval_ms: 2000,
});

/** Spec 0.2 configuration S (scaled down for integration and large documents). */
export const S_CONFIG = Object.freeze({
  max_document_bytes: 262_144,
  document_size_warn_ratio: 0.9,
  document_size_delete_headroom_bytes: 32_768,
  document_size_max_delete_splits: 1024,
  document_size_measure_interval_ms: 2000,
});

/** Derived lines of configuration D. */
export const D = Object.freeze({ L: 10_485_760, W: 9_437_184, CEIL: 10_747_904 });

/** Derived lines of configuration S; an integer `current` at or above `W` is a warning. */
export const S = Object.freeze({ L: 262_144, W: 235_930, CEIL: 294_912, MESSAGE: 327_680 });

/** Spec 0.2 document names. */
export const NAMES = Object.freeze({
  CV: "project-p1/canvas-s1",
  DOC: "project-p1/document-s2",
  TD: "project-p1/3d-s3",
  TL: "project-p1/timeline-s4",
  META: "project-p1/meta",
  ODD: "scratch-doc",
});

/**
 * Spec 0.2 `enc`: the encoded size of a document's full state.
 * @param doc - The document.
 * @returns Bytes.
 */
export function enc(doc: Y.Doc): number {
  return Y.encodeStateAsUpdate(doc).byteLength;
}

/**
 * Design 4.1 cost of an update against a document as it is now:
 * the message length plus `C` per split endpoint and per beyond-clock range;
 * 0 for a pure delete covering no live item, with no split endpoint and no
 * beyond-clock range.
 * @param update - The V1 update.
 * @param doc - The server document before the update.
 * @returns Bytes counted against the record.
 */
export function cost(update: Uint8Array, doc: Y.Doc): number {
  const s = updateShape(update, doc.store) as ReturnType<typeof updateShape> & { coversLive?: boolean };
  if (s.pureDelete && s.coversLive === false && s.splitEndpoints === 0 && s.beyondClockRanges === 0) return 0;
  return update.byteLength + C * (s.splitEndpoints + s.beyondClockRanges);
}

/**
 * A fresh document holding everything `doc` holds, pending content included.
 * @param doc - The source document.
 * @returns The copy.
 */
export function reload(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/**
 * Run one transaction on a client and return the update it emitted.
 * @param client - The client document.
 * @param edit - The edit, run inside one transaction.
 * @returns The V1 update of that transaction.
 * @throws {Error} When the edit changed nothing.
 */
export function capture(client: Y.Doc, edit: () => void): Uint8Array {
  let update: Uint8Array | undefined;
  const listener = (u: Uint8Array): void => {
    update = update ? Y.mergeUpdates([update, u]) : u;
  };
  client.on("update", listener);
  client.transact(edit);
  client.off("update", listener);
  if (!update) throw new Error("the edit emitted no update");
  return update;
}

/**
 * A client fully synced with `doc`.
 * @param doc - The document to copy.
 * @param clientID - The client id the copy writes under.
 * @returns The client document.
 */
export function syncedClient(doc: Y.Doc, clientID: number): Y.Doc {
  const client = new Y.Doc();
  client.clientID = clientID;
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  return client;
}

/** The handles of the spec 0.3 `nodeDoc` client. */
export interface NodeDoc {
  /** The server copy, synced once the fixture is built; later client edits do not reach it. */
  server: Y.Doc;
  /** The writing client, `clientID = 7`. */
  client: Y.Doc;
  /** `nodes`, the root map. */
  nodes: Y.Map<Y.Map<unknown>>;
  /** `nodes.n1`. */
  n1: Y.Map<unknown>;
  /** `n1.data`. */
  data: Y.Map<unknown>;
  /** `n1.data.focus`. */
  focus: Y.Array<string>;
  /** `n1.body`. */
  body: Y.XmlFragment;
  /** The paragraph inside `body`. */
  paragraph: Y.XmlElement;
  /** The text inside the paragraph, `"hello world"` inserted at once. */
  text: Y.XmlText;
}

/**
 * Spec 0.3 `nodeDoc()`: client 7 builds node `n1` with a data map, an XML
 * body and a three-item array, renames it twice, and syncs to a server copy.
 * The sync stops there: edits made afterwards are captured by the case and
 * reach the server only the way the case sends them.
 * @returns The handles.
 */
export function nodeDoc(): NodeDoc {
  const server = new Y.Doc();
  const client = new Y.Doc();
  client.clientID = 7;
  const sync = (u: Uint8Array): void => Y.applyUpdate(server, u);
  client.on("update", sync);
  const nodes = client.getMap<Y.Map<unknown>>("nodes");
  const n1 = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  const focus = new Y.Array<string>();
  const body = new Y.XmlFragment();
  const paragraph = new Y.XmlElement("paragraph");
  const text = new Y.XmlText();
  client.transact(() => {
    nodes.set("n1", n1);
    n1.set("data", data);
    data.set("locked", true);
    data.set("color", "red");
    n1.set("body", body);
    text.insert(0, "hello world");
    paragraph.insert(0, [text]);
    body.insert(0, [paragraph]);
    data.set("focus", focus);
  });
  focus.push(["a"]);
  focus.push(["b"]);
  focus.push(["c"]);
  n1.set("name", "x1");
  n1.set("name", "x2");
  client.off("update", sync);
  return { server, client, nodes, n1, data, focus, body, paragraph, text };
}

/**
 * Spec 0.3 `alt2000()`: client 11 inserts 2000 characters into `getText("t")` at once.
 * @returns The synced server copy, the client and the text.
 */
export function alt2000(): { server: Y.Doc; client: Y.Doc; t: Y.Text } {
  const server = new Y.Doc();
  const client = new Y.Doc();
  client.clientID = 11;
  const t = client.getText("t");
  t.insert(0, "x".repeat(2000));
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
  return { server, client, t };
}

/**
 * A pure-delete update written by hand: no structs, the given ranges.
 * @param ranges - `[client, clock, len]` triples, grouped by client in order.
 * @returns The V1 update.
 */
export function deleteOnly(ranges: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const byClient = new Map<number, Array<readonly [number, number]>>();
  for (const [client, clock, len] of ranges) {
    const list = byClient.get(client) ?? [];
    list.push([clock, len]);
    byClient.set(client, list);
  }
  const e = new Y.UpdateEncoderV1();
  encoding.writeVarUint(e.restEncoder, 0);
  encoding.writeVarUint(e.restEncoder, byClient.size);
  byClient.forEach((list, client) => {
    encoding.writeVarUint(e.restEncoder, client);
    encoding.writeVarUint(e.restEncoder, list.length);
    for (const [clock, len] of list) {
      e.writeDsClock(clock);
      e.writeDsLen(len);
    }
  });
  return e.toUint8Array();
}

/**
 * Spec 0.3 `beyondDs(client, clock, len)`.
 * @param client - The client the range names.
 * @param clock - The range start.
 * @param len - The range length.
 * @returns The V1 update.
 */
export function beyondDs(client: number, clock: number, len: number): Uint8Array {
  return deleteOnly([[client, clock, len]]);
}

/**
 * Spec 0.2 `dsBytes`: the delete set of an update written out on its own.
 * @param update - The V1 update.
 * @returns Bytes.
 */
export function dsBytes(update: Uint8Array): number {
  const ds = Y.decodeUpdate(update).ds;
  const e = new Y.UpdateEncoderV1();
  encoding.writeVarUint(e.restEncoder, ds.clients.size);
  ds.clients.forEach((items, client) => {
    encoding.writeVarUint(e.restEncoder, client);
    encoding.writeVarUint(e.restEncoder, items.length);
    for (const it of items) {
      e.writeDsClock(it.clock);
      e.writeDsLen(it.len);
    }
  });
  return e.toUint8Array().byteLength;
}

/** A source document whose later structs depend on clocks it withholds. */
export interface PendingSource {
  /** The update starting after the withheld clocks (it pends on any server lacking them). */
  update: Uint8Array;
  /** The source's full update from the empty state, withheld clocks included. */
  full: Uint8Array;
}

/**
 * Spec 0.3 `pendingStructs(client, n)`: five single `"a"` inserts are
 * withheld, then `n` `"z"` are inserted at the front of `getText("junk")`.
 * @param client - The source client id.
 * @param n - How many characters follow the withheld ones.
 * @returns The pending update and the source's full update.
 */
export function pendingSource(client: number, n: number): PendingSource {
  const e = new Y.Doc();
  e.clientID = client;
  const t = e.getText("junk");
  for (let i = 0; i < 5; i++) t.insert(0, "a");
  const sv = Y.encodeStateVector(e);
  t.insert(0, "z".repeat(n));
  const out = { update: Y.encodeStateAsUpdate(e, sv), full: Y.encodeStateAsUpdate(e) };
  e.destroy();
  return out;
}

/**
 * Spec 0.3 `pendingStructs(client, n)` as the update alone.
 * @param client - The source client id.
 * @param n - How many characters follow the withheld ones.
 * @returns The V1 update missing clocks 0-4.
 */
export function pendingStructs(client: number, n: number): Uint8Array {
  return pendingSource(client, n).update;
}

/**
 * Spec 0.3 `fillLegacy`: the full update of the `pendingStructs(500, 2000)`
 * source, supplying the clocks a `legacyDoc` lacks.
 * @returns The V1 update.
 */
export function fillLegacy(): Uint8Array {
  return pendingSource(500, 2000).full;
}

/**
 * Spec 0.3 `legacyDoc()`: a server document already holding pending content,
 * loaded without a connection origin (pending structs 2024 bytes, pending
 * delete set 22 bytes).
 * @returns The document.
 */
export function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("body").insert(0, "hello world");
  Y.applyUpdate(doc, pendingStructs(500, 2000));
  Y.applyUpdate(doc, deleteOnly([[4242, 100, 1], [4242, 102, 1], [4242, 104, 1]]));
  return doc;
}

/**
 * Spec P-08 `chunk(id, n).tail`: client `id` inserts `"abc"`, then `n`
 * characters; the part after the first three clocks.
 * @param id - The client id.
 * @param n - How many characters follow `"abc"`.
 * @returns The tail update (pends on clocks 0-2) and the head that supplies them.
 */
export function chunk(id: number, n: number): { tail: Uint8Array; full: Uint8Array } {
  const e = new Y.Doc();
  e.clientID = id;
  const t = e.getText("junk");
  t.insert(0, "abc");
  const sv = Y.encodeStateVector(e);
  t.insert(0, "q".repeat(n));
  const out = { tail: Y.encodeStateAsUpdate(e, sv), full: Y.encodeStateAsUpdate(e) };
  e.destroy();
  return out;
}

/**
 * Spec 0.3 `mass(N)`: `N` canvas nodes with nine data keys each, edited in
 * four interleaved rounds.
 * @param n - How many nodes.
 * @returns The synced server copy and the client.
 */
export function mass(n: number): { server: Y.Doc; client: Y.Doc; nodes: Y.Map<Y.Map<unknown>> } {
  const client = new Y.Doc();
  // Every item encodes its origin's client id, so a random id below 2^28
  // (four varuint bytes, not five) would shrink the document by about a byte
  // an item; the measured sizes are for a five-byte id.
  client.clientID = MASS_CLIENT;
  const nodes = client.getMap<Y.Map<unknown>>("nodes");
  client.transact(() => {
    for (let i = 0; i < n; i++) {
      const node = new Y.Map<unknown>();
      node.set("id", `n${i}`);
      node.set("type", "image");
      node.set("position", { x: i, y: 0 });
      const data = new Y.Map<unknown>();
      node.set("data", data);
      for (const k of ["name", "model", "mode", "params", "content", "coverUrl", "mediaWidth", "mediaHeight", "taskCounts"]) data.set(k, `${k}${i}`);
      nodes.set(`n${i}`, node);
    }
  });
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < n; i++) {
      const node = nodes.get(`n${i}`);
      if (!node) continue;
      node.set("position", { x: i, y: round });
      const data = node.get("data") as Y.Map<unknown>;
      data.set("params", { seed: round, i });
      data.set("name", `node ${i} r${round}`);
    }
  }
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client));
  return { server, client, nodes };
}

/** The client id `mass` writes with: five varuint bytes, as the spec's measures had. */
export const MASS_CLIENT = 0x2000_0001;

/** The client id `fill` writes with. */
export const FILL_CLIENT = 0xf00001;

/**
 * Spec 0.3 `fill(doc, target)`: add `f<i>` nodes whose `name` holds 10 000
 * `"x"` until the next would pass `target`, then one sized to land just under it.
 * @param doc - The document to grow (its client id is set to `FILL_CLIENT`).
 * @param target - The size aimed for.
 * @returns The measured size afterwards; cases assert on this, not on `target`.
 */
export function fill(doc: Y.Doc, target: number): number {
  doc.clientID = FILL_CLIENT;
  const nodes = doc.getMap<Y.Map<unknown>>("nodes");
  let i = 0;
  while (enc(doc) + 10_100 <= target) {
    const node = new Y.Map<unknown>();
    nodes.set(`f${i++}`, node);
    node.set("name", "x".repeat(10_000));
  }
  const rest = target - enc(doc) - 40;
  if (rest > 0) {
    const node = new Y.Map<unknown>();
    nodes.set(`f${i}`, node);
    node.set("name", "x".repeat(rest));
  }
  return enc(doc);
}

/**
 * The SyncStep2 payload an honest client answers the server's SyncStep1 with.
 * @param server - The server document (its state vector goes out).
 * @param client - The client document answering.
 * @returns The SyncStep2 update bytes.
 */
export function handshakeStep2(server: Y.Doc, client: Y.Doc): Uint8Array {
  const step1 = encoding.createEncoder();
  syncProtocol.writeSyncStep1(step1, server);
  const reply = encoding.createEncoder();
  syncProtocol.readSyncMessage(decoding.createDecoder(encoding.toUint8Array(step1)), reply, client, null);
  const decoder = decoding.createDecoder(encoding.toUint8Array(reply));
  decoding.readVarUint(decoder);
  return decoding.readVarUint8Array(decoder);
}

/**
 * A SyncStep1 payload: the state vector of `doc`.
 * @param doc - The document whose state vector is sent.
 * @returns The payload bytes.
 */
export function step1Payload(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

/**
 * Spec 14a.3: one new node `big` whose `name` holds 40 000 `"y"`, written by
 * client 0xA synced with `doc` (40 032 bytes on a `fill(doc, 230 000)` document).
 * @param doc - The server document the writer syncs from.
 * @returns The V1 update.
 */
export function bigNodeUpdate(doc: Y.Doc): Uint8Array {
  const writer = syncedClient(doc, 0xa);
  return capture(writer, () => {
    const big = new Y.Map<unknown>();
    writer.getMap<Y.Map<unknown>>("nodes").set("big", big);
    big.set("name", "y".repeat(40_000));
  });
}

/** Spec 14a.4: a document of 20 paragraphs and a member's offline deletes in it. */
export interface OfflineDeletes {
  /** The author's document: 20 paragraphs of 2000 `"w"` (40 607 bytes encoded). */
  author: Y.Doc;
  /**
   * The member (client 13) synced from `author`, who then deletes one
   * character at `50 + floor(k / 20) * 60` of paragraph `k % 20` for each `k < n`.
   * @param n - How many characters the member deletes.
   * @returns The member's document after the deletes.
   */
  memberAfter: (n: number) => Y.Doc;
}

/**
 * Spec 14a.4: client 11 builds 20 `paragraph` elements in
 * `getXmlFragment("document-store")`, each one `XmlText` with 2000 `"w"`
 * inserted at once.
 * @returns The author's document and a builder for the member's offline deletes.
 */
export function offlineDeletes(): OfflineDeletes {
  const author = new Y.Doc();
  author.clientID = 11;
  const fragment = author.getXmlFragment("document-store");
  for (let p = 0; p < 20; p++) {
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "w".repeat(2000));
    paragraph.insert(0, [text]);
    fragment.insert(fragment.length, [paragraph]);
  }
  return {
    author,
    memberAfter: (n: number): Y.Doc => {
      const member = syncedClient(author, 13);
      applyOfflineDeletes(member, n);
      return member;
    },
  };
}

/**
 * Spec 14a.4: delete one character at `50 + floor(k / 20) * 60` of paragraph
 * `k % 20` of `getXmlFragment("document-store")`, for each `k < n`.
 * @param doc - A copy of the `offlineDeletes` author's document.
 * @param n - How many characters to delete.
 */
export function applyOfflineDeletes(doc: Y.Doc, n: number): void {
  const f = doc.getXmlFragment("document-store");
  for (let k = 0; k < n; k++) {
    const text = (f.get(k % 20) as Y.XmlElement).get(0) as Y.XmlText;
    text.delete(50 + Math.floor(k / 20) * 60, 1);
  }
}

/**
 * Spec 14a.4: the SyncStep2 a reconnecting member sends,
 * `Y.encodeStateAsUpdate(member, Y.encodeStateVector(server))`.
 * @param member - The member's document.
 * @param server - The server document.
 * @returns The update.
 */
export function reconnectStep2(member: Y.Doc, server: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(member, Y.encodeStateVector(server));
}

/**
 * Read one of the `pendingBefore` / `pendingAfter` values of a step 2a
 * refusal log (design 4.3). Answer Q22 gives the pending structs'
 * and the pending delete set's coverage apart and leaves the key names to the
 * implementation: the key naming structs is the structs' coverage, the other
 * key the delete set's.
 * @param value - The logged value.
 * @returns Both coverages.
 * @throws {Error} When the value is not an object of exactly two numbers, one of them named for structs.
 */
export function pendingCoverage(value: unknown): { structs: number; ds: number } {
  if (typeof value !== "object" || value === null) throw new Error(`pending coverage is not an object: ${JSON.stringify(value)}`);
  const entries = Object.entries(value);
  const structs = entries.find(([key]) => /struct/i.test(key));
  const ds = entries.find(([key]) => !/struct/i.test(key));
  if (entries.length !== 2 || !structs || !ds || typeof structs[1] !== "number" || typeof ds[1] !== "number") {
    throw new Error(`pending coverage is not two numbers, one for structs: ${JSON.stringify(value)}`);
  }
  return { structs: structs[1], ds: ds[1] };
}
