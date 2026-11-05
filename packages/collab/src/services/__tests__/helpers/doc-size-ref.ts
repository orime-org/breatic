// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Test-side reference for the document size cap (inner#1790, test spec
 * sections 0.2, 0.3 and 4.2).
 *
 * Everything here is written from yjs alone and never imports
 * `services/document-size.ts`: `refMeasure`, `refTruth`, `refStoredReduced`
 * and `refDsBytes` are the independent recomputations the spec calls
 * `ref.measure`, `ref.truth`, `ref.storedReduced` and `ref.dsBytes`; the
 * builders reproduce the design-review probes (`adv1790-*`) the spec names;
 * `GENERATORS` are G1-G24 of spec 4.2.
 */

import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import fc from "fast-check";
import { DOC_SIZE_EVENT_BYTES } from "@breatic/shared";

/** The design 4.1 constant `C`, shared with web (spec 0.2, answer Q1). */
export const C: number = DOC_SIZE_EVENT_BYTES;

/** The scaled configuration of spec 0.2 ("S config"). */
export const S_CONFIG = Object.freeze({
  max_document_bytes: 1_048_576,
  document_size_warn_ratio: 0.8,
  document_size_full_margin_bytes: 26_214,
  document_size_delete_headroom_bytes: 26_214,
  document_size_overwrite_reserve_bytes: 6_554,
  document_size_measure_interval_ms: 2000,
  document_size_trials_per_user_per_minute: 6,
  document_size_trial_budget_ms_per_second: 200,
});

/** The repository defaults of spec 0.2 ("D config"). */
export const D_CONFIG = Object.freeze({
  max_document_bytes: 10_485_760,
  document_size_warn_ratio: 0.8,
  document_size_full_margin_bytes: 262_144,
  document_size_delete_headroom_bytes: 262_144,
  document_size_overwrite_reserve_bytes: 65_536,
  document_size_measure_interval_ms: 2000,
  document_size_trials_per_user_per_minute: 6,
  document_size_trial_budget_ms_per_second: 200,
});

/** Derived S config values (spec 0.2). */
export const S = Object.freeze({
  L: 1_048_576,
  CEIL: 1_074_790,
  FULL_AT: 1_022_362,
  /** The first integer `upper` that is `warning`. */
  WARN_FROM: 838_861,
  OVERWRITE: 6_554,
});

/** Derived D config values (spec 0.2). */
export const D = Object.freeze({
  L: 10_485_760,
  CEIL: 10_747_904,
  FULL_AT: 10_223_616,
  WARN_FROM: 8_388_608,
  OVERWRITE: 65_536,
});

/** Half-open clock intervals, `[start, end)`. */
type Ranges = Array<[number, number]>;

/** Pending content a document holds, per client, as merged intervals. */
export interface PendingIntervals {
  /** Pending structs (`store.pendingStructs`), Skip excluded. */
  structs: Map<number, Ranges>;
  /** Pending delete ranges (`store.pendingDs`). */
  deletes: Map<number, Ranges>;
}

/**
 * Sort and merge intervals.
 * @param ranges - Intervals in any order, possibly overlapping.
 * @returns Disjoint intervals in ascending order.
 */
function mergeRanges(ranges: Ranges): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Ranges = [];
  for (const [a, b] of sorted) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Units of `a` that `b` does not contain.
 * @param a - Merged intervals.
 * @param b - Merged intervals.
 * @returns The number of clocks in `a` and not in `b`.
 */
function unitsNotIn(a: Ranges, b: Ranges): number {
  let total = 0;
  for (const [x, y] of a) {
    let covered = 0;
    for (const [p, q] of b) covered += Math.max(0, Math.min(y, q) - Math.max(x, p));
    total += y - x - covered;
  }
  return total;
}

/**
 * Append an interval to a per-client map.
 * @param map - The map.
 * @param client - The client id.
 * @param range - The interval.
 */
function pushRange(map: Map<number, Ranges>, client: number, range: [number, number]): void {
  const list = map.get(client) ?? [];
  list.push(range);
  map.set(client, list);
}

/**
 * The pending units a document holds: structs per client and clock, delete
 * ranges per client and clock, Skip excluded (spec 0.2 `ref.truth`).
 * @param doc - The document.
 * @returns Merged intervals per client.
 */
export function pendingIntervals(doc: Y.Doc): PendingIntervals {
  const structs = new Map<number, Ranges>();
  const deletes = new Map<number, Ranges>();
  const ps = doc.store.pendingStructs;
  if (ps) {
    for (const s of Y.decodeUpdateV2(ps.update).structs) {
      if (s instanceof Y.Skip) continue;
      pushRange(structs, s.id.client, [s.id.clock, s.id.clock + s.length]);
    }
  }
  const pds = doc.store.pendingDs;
  if (pds) {
    Y.decodeUpdateV2(pds).ds.clients.forEach((rs, client) => {
      for (const r of rs) pushRange(deletes, client, [r.clock, r.clock + r.len]);
    });
  }
  for (const m of [structs, deletes]) for (const [c, rs] of m) m.set(c, mergeRanges(rs));
  return { structs, deletes };
}

/**
 * Units of `a` that `b` does not hold.
 * @param a - Pending content.
 * @param b - Pending content.
 * @returns The count of struct and delete units only `a` holds.
 */
export function pendingUnitsNotIn(a: PendingIntervals, b: PendingIntervals): number {
  let n = 0;
  for (const [c, rs] of a.structs) n += unitsNotIn(rs, b.structs.get(c) ?? []);
  for (const [c, rs] of a.deletes) n += unitsNotIn(rs, b.deletes.get(c) ?? []);
  return n;
}

/**
 * The number of pending structs (Skip excluded) and pending delete ranges.
 * @param doc - The document.
 * @returns `p` and `q` of spec 0.2.
 */
export function pendingCounts(doc: Y.Doc): { p: number; q: number; pWithSkip: number } {
  let p = 0;
  let pWithSkip = 0;
  let q = 0;
  const ps = doc.store.pendingStructs;
  if (ps) {
    for (const s of Y.decodeUpdateV2(ps.update).structs) {
      pWithSkip++;
      if (!(s instanceof Y.Skip)) p++;
    }
  }
  const pds = doc.store.pendingDs;
  if (pds) Y.decodeUpdateV2(pds).ds.clients.forEach((rs) => { q += rs.length; });
  return { p, q, pWithSkip };
}

/**
 * `ref.measure` (spec 0.2): encoded size plus `C` per pending struct and `2C`
 * per pending delete range.
 * @param doc - The document.
 * @returns The reference size in bytes.
 */
export function refMeasure(doc: Y.Doc): number {
  const { p, q } = pendingCounts(doc);
  return Y.encodeStateAsUpdate(doc).byteLength + C * p + 2 * C * q;
}

/**
 * `reload` (spec 0.3): what collab holds after storing and loading again;
 * pending content is kept.
 * @param doc - The document.
 * @returns A new document with the same state.
 */
export function reload(doc: Y.Doc): Y.Doc {
  const n = new Y.Doc({ gc: doc.gc });
  Y.applyUpdate(n, Y.encodeStateAsUpdate(doc));
  return n;
}

/**
 * Apply an update to a full replica and compare pending content before and
 * after.
 * @param doc - The server document (not changed).
 * @param update - A V1 update.
 * @returns Units added and units removed, and the replica's size change.
 */
export function replicaOutcome(doc: Y.Doc, update: Uint8Array): { added: number; removed: number; delta: number; replica: Y.Doc } {
  const replica = reload(doc);
  const before = pendingIntervals(replica);
  const pre = refMeasure(replica);
  Y.applyUpdate(replica, update);
  const after = pendingIntervals(replica);
  return {
    added: pendingUnitsNotIn(after, before),
    removed: pendingUnitsNotIn(before, after),
    delta: refMeasure(replica) - pre,
    replica,
  };
}

/**
 * `ref.truth` (spec 0.2): the full replica holds pending units it did not hold
 * before the update.
 * @param doc - The server document.
 * @param update - A V1 update.
 * @returns Whether new pending units appear.
 */
export function refTruth(doc: Y.Doc, update: Uint8Array): boolean {
  return replicaOutcome(doc, update).added > 0;
}

/**
 * `ref.storedReduced` (spec 0.2): pending units held before the update that the
 * replica no longer holds afterwards.
 * @param doc - The server document.
 * @param update - A V1 update.
 * @returns The number of such units.
 */
export function refStoredReduced(doc: Y.Doc, update: Uint8Array): number {
  return replicaOutcome(doc, update).removed;
}

/**
 * `Δ` (spec 0.2): reference size after applying to a full replica minus
 * before.
 * @param doc - The server document.
 * @param update - A V1 update.
 * @returns The size change in bytes.
 */
export function refDelta(doc: Y.Doc, update: Uint8Array): number {
  return replicaOutcome(doc, update).delta;
}

/**
 * `ref.dsBytes` (spec 0.2): the encoded length of a V1 update's delete set.
 * @param update - A V1 update.
 * @returns Bytes of the delete-set section.
 */
export function refDsBytes(update: Uint8Array): number {
  const ds = Y.decodeUpdate(update).ds;
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, ds.clients.size);
  ds.clients.forEach((ranges, client) => {
    enc.resetDsCurVal();
    encoding.writeVarUint(enc.restEncoder, client);
    encoding.writeVarUint(enc.restEncoder, ranges.length);
    for (const r of ranges) {
      enc.writeDsClock(r.clock);
      enc.writeDsLen(r.len);
    }
  });
  return enc.toUint8Array().byteLength;
}

const CHUNK_64K = "x".repeat(65_536);

/**
 * `fill` (spec 0.3): grow a document's text to about `target` reference bytes.
 * @param doc - The document; its client id is set to `client`.
 * @param target - The wanted reference size.
 * @param client - The writing client.
 * @returns The measured reference size (assert against this, not `target`).
 */
export function fill(doc: Y.Doc, target: number, client = 0xf00000aa): number {
  doc.clientID = client;
  const t = doc.getText("t");
  while (refMeasure(doc) + 65_600 <= target) t.insert(t.length, CHUNK_64K);
  const rest = target - refMeasure(doc) - 16;
  if (rest > 0) t.insert(t.length, "x".repeat(rest));
  return refMeasure(doc);
}

/**
 * `handshakeStep2` (spec 0.3): the SyncStep2 payload a client answers the
 * server's SyncStep1 with.
 * @param server - The server document.
 * @param client - The client document.
 * @returns The SyncStep2 payload (a V1 update).
 */
export function handshakeStep2(server: Y.Doc, client: Y.Doc): Uint8Array {
  const step1 = encoding.createEncoder();
  syncProtocol.writeSyncStep1(step1, server);
  const reply = encoding.createEncoder();
  syncProtocol.readSyncMessage(decoding.createDecoder(encoding.toUint8Array(step1)), reply, client, "handshake");
  const dec = decoding.createDecoder(encoding.toUint8Array(reply));
  decoding.readVarUint(dec);
  return decoding.readVarUint8Array(dec);
}

/**
 * A synced copy of a document under another client id.
 * @param doc - The document.
 * @param clientID - The copy's client id.
 * @returns The copy.
 */
export function syncedClient(doc: Y.Doc, clientID: number): Y.Doc {
  const c = new Y.Doc();
  c.clientID = clientID;
  Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
  return c;
}

/**
 * Everything a function writes to a document, as one V1 update.
 * @param doc - The document.
 * @param write - Runs inside one transaction.
 * @returns The merged update, or an empty update when nothing was written.
 */
export function capture(doc: Y.Doc, write: () => void): Uint8Array {
  const ups: Uint8Array[] = [];
  const h = (u: Uint8Array): void => {
    ups.push(u);
  };
  doc.on("update", h);
  try {
    doc.transact(write);
  } finally {
    doc.off("update", h);
  }
  return ups.length === 0 ? new Uint8Array([0, 0]) : Y.mergeUpdates(ups);
}

/**
 * Write as a given client on a shared document.
 * @param doc - The document.
 * @param client - The client id to write as.
 * @param write - The write.
 */
export function writeAs(doc: Y.Doc, client: number, write: () => void): void {
  doc.clientID = client;
  doc.transact(write);
}

/**
 * A hand-written V1 update with no structs and the given delete ranges.
 * @param entries - Per client, `[clock, len]` ranges in the order written.
 * @returns The update.
 */
export function deleteOnly(entries: Array<[number, Array<[number, number]>]>): Uint8Array {
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, 0);
  encoding.writeVarUint(enc.restEncoder, entries.length);
  for (const [client, ranges] of entries) {
    enc.resetDsCurVal();
    encoding.writeVarUint(enc.restEncoder, client);
    encoding.writeVarUint(enc.restEncoder, ranges.length);
    for (const [clock, len] of ranges) {
      enc.writeDsClock(clock);
      enc.writeDsLen(len);
    }
  }
  return enc.toUint8Array();
}

/** One client's structs in a hand-written update. */
interface StructGroup {
  client: number;
  clock: number;
  structs: Array<Y.Item | Y.GC>;
}

/**
 * A hand-written V1 update.
 * @param groups - Client groups in the order written (yjs writes higher ids first).
 * @param ds - Delete ranges per client.
 * @returns The update.
 */
export function craft(groups: StructGroup[], ds: Array<[number, Array<[number, number]>]> = []): Uint8Array {
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, groups.length);
  for (const g of groups) {
    encoding.writeVarUint(enc.restEncoder, g.structs.length);
    enc.writeClient(g.client);
    encoding.writeVarUint(enc.restEncoder, g.clock);
    for (const s of g.structs) s.write(enc, 0);
  }
  encoding.writeVarUint(enc.restEncoder, ds.length);
  for (const [client, ranges] of ds) {
    enc.resetDsCurVal();
    encoding.writeVarUint(enc.restEncoder, client);
    encoding.writeVarUint(enc.restEncoder, ranges.length);
    for (const [clock, len] of ranges) {
      enc.writeDsClock(clock);
      enc.writeDsLen(len);
    }
  }
  return enc.toUint8Array();
}

/**
 * A one-char string item from `client` placed by origin / right origin.
 * @param client - The writing client.
 * @param clock - Its clock.
 * @param origin - Left origin.
 * @param rightOrigin - Right origin.
 * @param text - The content.
 * @returns The item (not integrated).
 */
export function stringItem(client: number, clock: number, origin: Y.ID | null, rightOrigin: Y.ID | null, text: string): Y.Item {
  return new Y.Item(Y.createID(client, clock), null, origin, null, rightOrigin, null, null, new Y.ContentString(text));
}

/**
 * Live items of a sequence type, in order.
 * @param type - A `Y.Text` or `Y.Array`.
 * @returns Its non-deleted items.
 */
export function liveItems(type: { _start: Y.Item | null }): Y.Item[] {
  const out: Y.Item[] = [];
  for (let it = type._start; it; it = it.right) if (!it.deleted) out.push(it);
  return out;
}

/**
 * Live ContentFormat items of a text.
 * @param text - The text.
 * @returns Its non-deleted format items.
 */
export function liveFormatItems(text: Y.Text): Y.Item[] {
  return liveItems(text).filter((it) => it.content instanceof Y.ContentFormat);
}

/**
 * The deterministic LCG the probes use (`seed·1103515245 + 12345 mod 2^31`).
 * @param seed - The seed.
 * @returns A generator of numbers in [0, 1).
 */
export function lcg(seed: number): () => number {
  let s = seed % 2147483648;
  return (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * A random integer in `[min, max]`.
 * @param rnd - The generator.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns The integer.
 */
function randInt(rnd: () => number, min: number, max: number): number {
  return min + Math.floor(rnd() * (max - min + 1));
}

/**
 * The internal item of a map key.
 * @param map - The map.
 * @param key - The key.
 * @returns The item holding the key's current value.
 * @throws {Error} When the key is unset.
 */
export function mapItem(map: Y.Map<unknown>, key: string): Y.Item {
  const it = map._map.get(key);
  if (!it) throw new Error(`no item for ${key}`);
  return it;
}

// --------------------------------------------------------------------------
// Builders for the probes the spec cites (spec 0.3, 3, 4.2).
// --------------------------------------------------------------------------

/**
 * `canvasDoc(n, del)` (`adv1790-r7-scheme/reconnect-bound-canvas.mjs`).
 * @param n - Node count.
 * @param del - Share of nodes deleted.
 * @returns The server document.
 */
export function canvasDoc(n: number, del: number): Y.Doc {
  const server = new Y.Doc();
  const nodes = server.getMap<Y.Map<unknown>>("nodes");
  for (let i = 0; i < n; i++) {
    const node = new Y.Map<unknown>();
    nodes.set("n" + i, node);
    node.set("x", i);
    node.set("y", i);
    const body = new Y.Text();
    node.set("body", body);
    body.insert(0, "text of node " + i);
    for (let k = 0; k < 5; k++) node.set("x", i + k);
  }
  for (let i = 0; i < n; i++) if (((i * 7919) % n) / n < del) nodes.delete("n" + i);
  return server;
}

/**
 * `imageNodes(k)` / `textNodes(k)` (`adv1790-r4-direction/node-delete-bound.cjs`).
 * @param kind - Image or text nodes.
 * @param k - Node count.
 * @returns The document.
 */
export function nodesDoc(kind: "image" | "text", k: number): Y.Doc {
  const d = new Y.Doc();
  d.clientID = 0xf00000aa;
  const nodes = d.getMap<Y.Map<unknown>>("nodes");
  for (let i = 0; i < k; i++) {
    d.transact(() => {
      const n = new Y.Map<unknown>();
      nodes.set("node-" + i, n);
      n.set("type", kind);
      n.set("x", i * 10.5);
      n.set("y", i * 3.25);
      n.set("w", 320);
      n.set("h", 240);
      n.set("name", "Image " + i);
      n.set("url", "https://cdn.example.com/assets/" + "f".repeat(64) + ".png");
      const data = new Y.Map<unknown>();
      n.set("data", data);
      data.set("status", "done");
      data.set("model", "model-x");
      if (kind === "text") {
        const t = new Y.Text();
        n.set("body", t);
        t.insert(0, "lorem ipsum ".repeat(40));
      }
    });
  }
  for (let r = 0; r < 3; r++) for (let i = 0; i < k; i++) d.transact(() => nodes.get("node-" + i)?.set("x", r + i));
  return d;
}

/**
 * `imageNodes(k)` (spec 0.3).
 * @param k - Node count.
 * @returns The document.
 */
export function imageNodes(k: number): Y.Doc {
  return nodesDoc("image", k);
}

/**
 * `textNodes(k)` (spec 0.3).
 * @param k - Node count.
 * @returns The document.
 */
export function textNodes(k: number): Y.Doc {
  return nodesDoc("text", k);
}

/**
 * `fragText(k)` (`adv1790-r7-scheme/reconnect-offline-bound.mjs`).
 * @param k - Insert count.
 * @returns The server document.
 */
export function fragText(k: number): Y.Doc {
  const server = new Y.Doc();
  const t = server.getText("t");
  for (let i = 0; i < k; i++) {
    const pos = (i * 7919) % (t.length + 1);
    t.insert(pos, "w");
    if (i % 8 === 7) t.delete(pos, 1);
  }
  return server;
}

/**
 * `structs-cases` B (`adv1790-r8-direction/structs-cases.cjs`): stored pending
 * X:5-9 whose predecessor was lost; the author reconnects with offline X:10-14.
 * @returns The reloaded server and the author's handshake SyncStep2.
 */
export function structsCasesB(): { server: Y.Doc; step2: Uint8Array } {
  const x = new Y.Doc();
  x.clientID = 1;
  const t = x.getText("t");
  const ups: Uint8Array[] = [];
  x.on("update", (u: Uint8Array) => ups.push(u));
  t.insert(0, "aaaaa");
  t.insert(5, "bbbbb");
  const server0 = new Y.Doc();
  Y.applyUpdate(server0, ups[1]!);
  const server = reload(server0);
  t.insert(10, "ccccc");
  return { server, step2: handshakeStep2(server, x) };
}

/**
 * `structs-cases` C: echo the held pending struct P plus S whose origin is P.
 * @param sLen - Length of S.
 * @param pLen - Length of the struct on the missing client.
 * @returns The server and the update.
 */
export function structsCasesC(sLen = 2000, pLen = 4): { server: Y.Doc; update: Uint8Array } {
  const base = new Y.Doc();
  base.clientID = 1;
  base.getText("t").insert(0, "hello");
  const a = new Y.Doc();
  a.clientID = 7;
  Y.applyUpdate(a, Y.encodeStateAsUpdate(base));
  a.getText("t").insert(5, "A".repeat(pLen));
  const sv7 = Y.encodeStateVector(a);
  a.clientID = 8;
  a.getText("t").insert(5 + pLen, "B");
  const pendingP = Y.encodeStateAsUpdate(a, sv7);
  const sv8 = Y.encodeStateVector(a);
  a.clientID = 9;
  a.getText("t").insert(6 + pLen, "S".repeat(sLen));
  const sOnly = Y.encodeStateAsUpdate(a, sv8);
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(base));
  Y.applyUpdate(server, pendingP);
  return { server, update: Y.mergeUpdates([pendingP, sOnly]) };
}

/** The scenes `ds-adjacent.cjs` builds. */
export interface DsAdjacent {
  /** Server reloaded with `pendingDs` client 1 `[5, 10)` (or as parameterised). */
  server: Y.Doc;
  /** Member Z (client 2) synced, typed one char offline, handshake SyncStep2. */
  zStep2: Uint8Array;
  /** A synced member with no edit, handshake SyncStep2 (echoes the pending). */
  echoStep2: Uint8Array;
  /** The author X reconnecting (supplies the clocks `pendingDs` covers). */
  authorStep2: Uint8Array;
}

/**
 * `ds-adjacent.cjs` (`adv1790-r8-direction`), parameterised for G14 and G21.
 * @param world - The lost insert X:5.. (default `'WORLD'`).
 * @param delFrom - Start of the author's delete (default 3).
 * @param delLen - Length of the author's delete (default 7).
 * @param zEdit - Member Z's offline edit.
 * @returns The scenes.
 */
export function dsAdjacent(world = "WORLD", delFrom = 3, delLen = 7, zEdit: (t: Y.Text) => void = (t) => t.insert(0, "z")): DsAdjacent {
  const x = new Y.Doc();
  x.clientID = 1;
  x.getText("t").insert(0, "hello");
  const server0 = new Y.Doc();
  Y.applyUpdate(server0, Y.encodeStateAsUpdate(x));
  x.getText("t").insert(5, world);
  const del = capture(x, () => x.getText("t").delete(delFrom, delLen));
  Y.applyUpdate(server0, del);
  const server = reload(server0);
  const z = syncedClient(server, 2);
  zEdit(z.getText("t"));
  const zStep2 = handshakeStep2(server, z);
  const z2 = syncedClient(server, 3);
  return { server, zStep2, echoStep2: handshakeStep2(server, z2), authorStep2: handshakeStep2(server, x) };
}

/**
 * `wouldpend-def.cjs` S1: author's first message lost, the second stored as
 * pending; reconnect after an offline backspace and keystroke.
 * @param delPos - Offline delete position (default 4).
 * @param insPos - Offline insert position (default 5).
 * @returns The reloaded server and the reconnect update.
 */
export function s1(delPos = 4, insPos = 5): { server: Y.Doc; update: Uint8Array } {
  const x = new Y.Doc();
  x.clientID = 777;
  const t = x.getText("t");
  t.insert(0, "abc");
  const sv1 = Y.encodeStateVector(x);
  t.insert(3, "def");
  const srv0 = new Y.Doc();
  Y.applyUpdate(srv0, Y.encodeStateAsUpdate(x, sv1));
  const server = reload(srv0);
  t.delete(delPos, 1);
  t.insert(Math.min(insPos, t.length), "g");
  return { server, update: Y.encodeStateAsUpdate(x, Y.encodeStateVector(server)) };
}

/**
 * `wouldpend-s5.cjs` S5: the author types inside its own stored-pending text,
 * then reconnects.
 * @param pos - Where it types (default 4).
 * @returns The reloaded server and the reconnect update.
 */
export function s5(pos = 4): { server: Y.Doc; update: Uint8Array } {
  const x = new Y.Doc();
  x.clientID = 4321;
  const t = x.getText("t");
  t.insert(0, "abc");
  const sv1 = Y.encodeStateVector(x);
  t.insert(3, "def");
  const s0 = new Y.Doc();
  Y.applyUpdate(s0, Y.encodeStateAsUpdate(x, sv1));
  const server = reload(s0);
  t.insert(pos, "Q");
  return { server, update: Y.encodeStateAsUpdate(x, Y.encodeStateVector(server)) };
}

/**
 * `wouldpend-def.cjs` S2: the server holds X:0-5 and `pendingDs` X:[5,20); a
 * synced member deletes next to it offline.
 * @param memberDelete - The member's offline delete (default `delete(4, 1)`).
 * @returns The reloaded server and the member's SyncStep2.
 */
export function s2(memberDelete: (t: Y.Text) => void = (t) => t.delete(4, 1)): { server: Y.Doc; update: Uint8Array } {
  const x = new Y.Doc();
  x.clientID = 900;
  const t = x.getText("t");
  t.insert(0, "hello");
  const u1 = Y.encodeStateAsUpdate(x);
  t.insert(5, "X".repeat(15));
  const sv2 = Y.encodeStateVector(x);
  t.delete(5, 15);
  const u3 = Y.encodeStateAsUpdate(x, sv2);
  const srv0 = new Y.Doc();
  Y.applyUpdate(srv0, u1);
  Y.applyUpdate(srv0, u3);
  const server = reload(srv0);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(server));
  memberDelete(b.getText("t"));
  return { server, update: Y.encodeStateAsUpdate(b, Y.encodeStateVector(server)) };
}

/**
 * `wouldpend-def.cjs` S3: a struct whose origin sits in stored pendingStructs.
 * @param len - Length of the attacker's insert (default 4).
 * @returns The reloaded server and the update.
 */
export function s3(len = 4): { server: Y.Doc; update: Uint8Array } {
  const x = new Y.Doc();
  x.clientID = 555;
  const t = x.getText("t");
  t.insert(0, "abc");
  const sv1 = Y.encodeStateVector(x);
  t.insert(3, "def");
  const srv0 = new Y.Doc();
  Y.applyUpdate(srv0, Y.encodeStateAsUpdate(x, sv1));
  const server = reload(srv0);
  const z = new Y.Doc();
  z.clientID = 556;
  Y.applyUpdate(z, Y.encodeStateAsUpdate(x));
  const before = Y.encodeStateVector(z);
  z.getText("t").insert(5, "Z".repeat(len));
  return { server, update: Y.encodeStateAsUpdate(z, before) };
}

/**
 * `structs-b2.cjs`: stored pendingStructs X:5-9 as a separate item, X:0-4
 * lost; the author reconnects with offline X:10-14.
 * @param p1 - Position of the first insert (default 2).
 * @param p2 - Position of the second insert (default 12).
 * @param p3 - Position of the offline insert (default 0).
 * @returns The reloaded server and the author's SyncStep2.
 */
export function structsB2(p1 = 2, p2 = 12, p3 = 0): { server: Y.Doc; step2: Uint8Array } {
  const base = new Y.Doc();
  base.clientID = 1;
  base.getText("t").insert(0, "0123456789");
  const x = syncedClient(base, 5);
  const t = x.getText("t");
  const ups: Uint8Array[] = [];
  x.on("update", (u: Uint8Array) => ups.push(u));
  t.insert(p1, "aaaaa");
  t.insert(Math.min(p2, t.length), "bbbbb");
  const server0 = new Y.Doc();
  Y.applyUpdate(server0, Y.encodeStateAsUpdate(base));
  Y.applyUpdate(server0, ups[1]!);
  const server = reload(server0);
  t.insert(Math.min(p3, t.length), "ccccc");
  return { server, step2: handshakeStep2(server, x) };
}

/**
 * `cycle.cjs`: two structs (clients 21, 22) whose origins point at each other.
 * @param len - Content length of each (default 3000).
 * @returns The server and the update.
 */
export function cycle(len = 3000): { server: Y.Doc; update: Uint8Array } {
  const base = new Y.Doc();
  base.clientID = 1;
  base.getText("t").insert(0, "hello");
  const server = reload(base);
  const update = craft([
    { client: 22, clock: 0, structs: [stringItem(22, 0, Y.createID(21, 0), null, "Q".repeat(len))] },
    { client: 21, clock: 0, structs: [stringItem(21, 0, Y.createID(22, 0), null, "Q".repeat(len))] },
  ]);
  return { server, update };
}

/**
 * `skip-gap.cjs`: a merged update of X's 5..6 transaction, a Skip over 6..10
 * and an 800 KB insert at 10.. whose predecessor never arrived.
 * @param tail - Length of the late insert (default 800000).
 * @returns The server, the update and the client's updates in order.
 */
export function skipGap(tail = 800_000): { server: Y.Doc; update: Uint8Array; ups: Uint8Array[] } {
  const x = new Y.Doc();
  x.clientID = 7;
  const t = x.getText("t");
  const ups: Uint8Array[] = [];
  x.on("update", (u: Uint8Array) => ups.push(u));
  t.insert(0, "hello");
  t.insert(5, "A");
  t.insert(6, "BBBB");
  t.insert(0, "z".repeat(tail));
  t.insert(1, "C");
  t.insert(2, "D");
  const server = new Y.Doc();
  Y.applyUpdate(server, ups[0]!);
  return { server, update: Y.mergeUpdates([ups[1]!, ups[3]!]), ups };
}

/**
 * `pend-growth.cjs`: a delete-only update whose ranges all lie beyond the
 * server's clocks.
 * @param ranges - Number of one-clock ranges (default 200000, about 800 KB).
 * @returns The server and the update.
 */
export function pendGrowth(ranges = 200_000): { server: Y.Doc; update: Uint8Array } {
  const server = new Y.Doc();
  server.getText("t").insert(0, "x".repeat(1000));
  const list: Array<[number, number]> = [];
  for (let i = 0; i < ranges; i++) list.push([1_000_000 + 2 * i, 1]);
  return { server, update: deleteOnly([[4242, list]]) };
}

/**
 * `preload-pend.cjs`: the pending-only payload (client 4242 `[1e6, 2e6)`).
 * @returns The (empty) server and the payload.
 */
export function preloadPend(): { server: Y.Doc; update: Uint8Array } {
  return { server: new Y.Doc(), update: deleteOnly([[4242, [[1_000_000, 1_000_000]]]]) };
}

/**
 * A struct whose own client's previous update never arrived (spec C-46 (b)).
 * @returns The server and the second update.
 */
export function missingDependency(): { server: Y.Doc; update: Uint8Array } {
  const server = new Y.Doc();
  server.clientID = 1;
  server.getText("t").insert(0, "hello");
  const x = syncedClient(server, 31);
  const ups: Uint8Array[] = [];
  x.on("update", (u: Uint8Array) => ups.push(u));
  x.getText("t").insert(5, "abc");
  x.getText("t").insert(8, "def");
  return { server, update: ups[1]! };
}

/**
 * `wouldpend-own-structs.cjs`: offline typing with a backspace; the delete
 * range covers clocks the update itself inserts.
 * @returns The server and the reconnect update.
 */
export function wouldpendOwnStructs(): { server: Y.Doc; update: Uint8Array } {
  const server = new Y.Doc();
  server.getText("t").insert(0, "hello");
  const client = syncedClient(server, 0x5150);
  const sv = Y.encodeStateVector(server);
  client.getText("t").insert(5, " wrold");
  client.getText("t").delete(7, 3);
  client.getText("t").insert(7, "orl");
  return { server, update: Y.encodeStateAsUpdate(client, sv) };
}

/**
 * The content behind `stored-pending-loop.cjs` MODE=ds as spec C-32 states
 * it: text plus a hand-written delete range client 4242 `[100, 105)`, reloaded.
 * @returns The reloaded document.
 */
export function storedPendingDs(): Y.Doc {
  const d = new Y.Doc();
  d.clientID = 11;
  d.getText("t").insert(0, "existing content");
  Y.applyUpdate(d, deleteOnly([[4242, [[100, 5]]]]));
  return reload(d);
}

/** `nested-cascade.cjs` and its relatives: a map key holding a nested array. */
export interface NestedDoc {
  doc: Y.Doc;
  /** The array under `m.x`. */
  arr: Y.Array<unknown>;
  /** The item holding `m.x`. */
  typeItem: Y.Item;
  /** Clocks of the sparse children client 2 wrote into the array. */
  childClocks: number[];
}

/**
 * `nested-cascade.cjs` / `overwrite-cascade.cjs` / `stored-pending-integrate.cjs`
 * content: `m.x` is a `Y.Array` whose `K` children (client 2) have sparse
 * clocks, interleaved with root array `g`.
 * @param k - Number of sparse children.
 * @param gap - Clock where client 2's GC run ends (default 2^40).
 * @returns The document and its parts.
 */
export function nestedDoc(k: number, gap = 2 ** 40): NestedDoc {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const arr = new Y.Array<unknown>();
  doc.getMap("m").set("x", arr);
  arr.push([0]);
  doc.getArray("g").push([0]);
  const typeItem = mapItem(doc.getMap("m"), "x");
  const anchor = arr._start!;
  const ganchor = doc.getArray("g")._start!;
  const structs: Array<Y.Item | Y.GC> = [new Y.GC(Y.createID(2, 0), gap)];
  const childClocks: number[] = [];
  for (let i = 0; i < k; i++) {
    childClocks.push(gap + 2 * i);
    structs.push(new Y.Item(Y.createID(2, gap + 2 * i), null, anchor.id, null, null, null, null, new Y.ContentBinary(new Uint8Array(0))));
    structs.push(new Y.Item(Y.createID(2, gap + 2 * i + 1), null, ganchor.id, null, null, null, null, new Y.ContentBinary(new Uint8Array(0))));
  }
  Y.applyUpdate(doc, craft([{ client: 2, clock: 0, structs }]));
  return { doc, arr, typeItem, childClocks };
}

/**
 * `overwrite-cascade.cjs`: one struct (client 3) written to `m.x` with origin =
 * the current value.
 * @param n - The nested document.
 * @returns The update.
 */
export function overwriteUpdate(n: NestedDoc): Uint8Array {
  return craft([{ client: 3, clock: 0, structs: [new Y.Item(Y.createID(3, 0), null, n.typeItem.lastId, null, null, null, null, new Y.ContentAny([1]))] }]);
}

/**
 * `stored-pending-integrate.cjs`: a stored pending map overwrite of `m.x` and
 * the 16-byte update that fills its gap.
 * @param k - Sparse children under `m.x`.
 * @returns The reloaded server and the gap filler.
 */
export function storedPendingIntegrate(k: number): { server: Y.Doc; filler: Uint8Array } {
  const n = nestedDoc(k);
  Y.applyUpdate(n.doc, craft([{ client: 3, clock: 1, structs: [new Y.Item(Y.createID(3, 1), null, n.typeItem.lastId, null, null, null, null, new Y.ContentAny([1]))] }]));
  const server = reload(n.doc);
  let last = server.getArray("g")._start!;
  while (last.right) last = last.right;
  const filler = craft([{ client: 3, clock: 0, structs: [new Y.Item(Y.createID(3, 0), null, last.lastId, null, null, null, null, new Y.ContentAny([7]))] }]);
  return { server, filler };
}

/**
 * `format-cleanup-k.cjs`: `m` gaps of `k` format keys each around 2-char
 * strings (client 7), interleaved clocks on client 8.
 * @param m - Number of strings.
 * @param k - Format keys per gap.
 * @returns The reloaded server, the text and the strings' client.
 */
export function formatCleanupDoc(m: number, k: number): { server: Y.Doc; textOf: (d: Y.Doc) => Y.Text; stringClient: number } {
  const B = 2 ** 49;
  const A = 7;
  const F = 8;
  const d = new Y.Doc();
  d.clientID = 1;
  d.getArray("g").push([0]);
  const nt = new Y.Text();
  d.getMap("m").set("body", nt);
  nt.insert(0, "S");
  const anchor = nt._start!;
  const ganchor = d.getArray("g")._start!;
  const fStructs: Array<Y.Item | Y.GC> = [new Y.GC(Y.createID(F, 0), B)];
  let fc2 = B;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < k; j++) {
      const origin = j > 0 ? Y.createID(F, fc2 - 2) : i === 0 ? anchor.id : Y.createID(A, 2 * i - 1);
      fStructs.push(new Y.Item(Y.createID(F, fc2), null, origin, null, null, null, null, new Y.ContentFormat("k" + j, i)));
      fStructs.push(new Y.Item(Y.createID(F, fc2 + 1), null, ganchor.id, null, null, null, null, new Y.ContentBinary(new Uint8Array(0))));
      fc2 += 2;
    }
  }
  const aStructs: Y.Item[] = [];
  for (let i = 0; i < m; i++) {
    aStructs.push(new Y.Item(Y.createID(A, 2 * i), null, Y.createID(F, B + 2 * k * i + 2 * (k - 1)), null, null, null, null, new Y.ContentString("xy")));
  }
  Y.applyUpdate(d, craft([{ client: F, clock: 0, structs: fStructs }, { client: A, clock: 0, structs: aStructs }]));
  const textOf = (doc: Y.Doc): Y.Text => doc.getMap("m").get("body") as Y.Text;
  return { server: reload(d), textOf, stringClient: A };
}

/**
 * `freed-overlap.cjs` content: a type item, sparse children, and one live
 * 20000-char string item `X`.
 * @param k - Sparse children under `m.x`.
 * @returns The document, the type item and `X`.
 */
export function freedOverlapDoc(k: number): { doc: Y.Doc; typeItem: Y.Item; x: Y.Item } {
  const n = nestedDoc(k, 2 ** 49);
  n.doc.clientID = 1;
  n.doc.getText("big").insert(0, "y".repeat(20000));
  const x = n.doc.getText("big")._start!;
  return { doc: n.doc, typeItem: n.typeItem, x };
}

/**
 * A map document written by `clients` distinct clients, one key each
 * (`skel-scale.cjs`, built as one hand-written update), plus a text written
 * by client 999.
 * @param clients - Number of clients.
 * @returns The server document.
 */
export function manyClientDoc(clients: number): Y.Doc {
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, clients);
  for (let c = 0; c < clients; c++) {
    encoding.writeVarUint(enc.restEncoder, 1);
    enc.writeClient(1000 + c);
    encoding.writeVarUint(enc.restEncoder, 0);
    // ContentAny (8) with parentSub (BIT6); no origins, so parent info follows.
    enc.writeInfo(8 | 0x20);
    enc.writeParentInfo(true);
    enc.writeString("m");
    enc.writeString("k" + c);
    new Y.ContentAny([c]).write(enc, 0);
  }
  encoding.writeVarUint(enc.restEncoder, 0);
  const server = new Y.Doc();
  Y.applyUpdate(server, enc.toUint8Array());
  writeAs(server, 999, () => server.getText("t").insert(0, "hello world"));
  return server;
}

// --------------------------------------------------------------------------
// Generators G1-G24 (spec 4.2).
// --------------------------------------------------------------------------

/** One generated case: a server document and a V1 update for it. */
export interface Sample {
  /** The generator that made it. */
  g: string;
  d: Y.Doc;
  u: Uint8Array;
}

const seed = fc.integer({ min: 1, max: 0x7ffffffe });

/**
 * Random history of up to three clients on one text, all on one document.
 * @param rnd - The generator.
 * @param d - The document.
 * @param clients - Client ids to write as.
 * @param steps - Number of writes.
 */
function randomTextHistory(rnd: () => number, d: Y.Doc, clients: number[], steps: number): void {
  const t = d.getText("t");
  for (let s = 0; s < steps; s++) {
    const c = clients[Math.floor(rnd() * clients.length)]!;
    if (rnd() < 0.7 || t.length === 0) writeAs(d, c, () => t.insert(Math.floor(rnd() * (t.length + 1)), "x".repeat(1 + Math.floor(rnd() * 4))));
    else {
      const p = Math.floor(rnd() * t.length);
      writeAs(d, c, () => t.delete(p, 1 + Math.floor(rnd() * Math.min(4, t.length - p))));
    }
  }
}

/** Two 5-byte varuint client ids (`two-splits.cjs`, `double-split.cjs`). */
const A5 = 0xf0000001;
const B5 = 0xf0000002;

/** G1: insert and origin splits. */
const g1 = fc.record({ s: seed, clients: fc.integer({ min: 1, max: 3 }), steps: fc.integer({ min: 0, max: 12 }), crafted: fc.boolean() }).map((p): Sample => {
  const rnd = lcg(p.s);
  const d = new Y.Doc();
  const t = d.getText("t");
  writeAs(d, A5, () => t.insert(Math.floor(rnd() * (t.length + 1)), "abc"));
  writeAs(d, B5, () => t.insert(Math.floor(rnd() * (t.length + 1)), "abc"));
  randomTextHistory(rnd, d, [101, 102, 103].slice(0, p.clients), p.steps);
  if (p.crafted) {
    const a = liveItems(t).find((it) => it.id.client === A5 && it.length >= 2);
    const b = liveItems(t).find((it) => it.id.client === B5 && it.length >= 2);
    if (a && b) {
      const u = craft([{ client: 7, clock: 0, structs: [stringItem(7, 0, Y.createID(A5, a.id.clock), Y.createID(B5, b.id.clock + 1), "y")] }]);
      return { g: "G1", d, u };
    }
  }
  const c = syncedClient(d, 200);
  const ct = c.getText("t");
  const u = capture(c, () => ct.insert(Math.floor(rnd() * (ct.length + 1)), "y".repeat(1 + Math.floor(rnd() * 4))));
  return { g: "G1", d, u };
});

/** G2: delete of a nested type with sparse-clock children. */
const g2 = fc.integer({ min: 1, max: 3000 }).map((k): Sample => {
  const n = nestedDoc(k);
  return { g: "G2", d: n.doc, u: deleteOnly([[1, [[n.typeItem.id.clock, 1]]]]) };
});

/** G3: map overwrite of a type value (crafted, or through the API). */
const g3 = fc.record({ k: fc.integer({ min: 1, max: 3000 }), api: fc.boolean() }).map((p): Sample => {
  if (!p.api) {
    const n = nestedDoc(p.k);
    return { g: "G3", d: n.doc, u: overwriteUpdate(n) };
  }
  const d = new Y.Doc();
  d.clientID = 1;
  const sub = new Y.Map<unknown>();
  d.getMap("m").set("x", sub);
  for (let i = 0; i < Math.min(p.k, 300); i++) sub.set("c" + i, i);
  const c = syncedClient(d, 3);
  return { g: "G3", d, u: capture(c, () => c.getMap("m").set("x", 5)) };
});

/** G4: alternating single-char deletes on filled text (`delete-max.cjs`). */
const g4 = fc.record({ s: seed, target: fc.integer({ min: 2000, max: 70_000 }), count: fc.integer({ min: 1, max: 200 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const d = new Y.Doc();
  fill(d, p.target);
  const len = d.getText("t").length;
  const odd: number[] = [];
  for (let c = 1; c < len; c += 2) odd.push(c);
  const picked = new Set<number>();
  while (picked.size < Math.min(p.count, odd.length)) picked.add(odd[Math.floor(rnd() * odd.length)]!);
  const ranges = [...picked].sort((a, b) => a - b).map((c): [number, number] => [c, 1]);
  return { g: "G4", d, u: deleteOnly([[0xf00000aa, ranges]]) };
});

const bigDocs = new Map<string, Y.Doc>();

/**
 * A cached G5 base document; callers must not change it.
 * @param key - Cache key.
 * @param build - Builder.
 * @returns The document.
 */
function cachedDoc(key: string, build: () => Y.Doc): Y.Doc {
  let d = bigDocs.get(key);
  if (!d) {
    d = build();
    bigDocs.set(key, d);
  }
  return d;
}

const g5Base = fc.oneof(
  fc.record({ n: fc.integer({ min: 200, max: 2000 }), del: fc.integer({ min: 1, max: 9 }) }).map((p) => cachedDoc(`canvas:${p.n}:${p.del}`, () => canvasDoc(p.n, p.del / 10))),
  fc.integer({ min: 2000, max: 20_000 }).map((k) => cachedDoc(`frag:${k}`, () => fragText(k))),
);

/** G5: reconnect delete set (synced client, no edit). */
const g5 = g5Base.map((d): Sample => ({ g: "G5", d, u: handshakeStep2(d, syncedClient(d, 0x7e57)) }));

/** G6: repeated and overlapping delete ranges. */
const g6 = fc.record({ s: seed, steps: fc.integer({ min: 1, max: 12 }), segs: fc.integer({ min: 1, max: 5 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const d = new Y.Doc();
  randomTextHistory(rnd, d, [11, 12, 13], p.steps);
  const entries: Array<[number, Array<[number, number]>]> = [];
  for (const c of [11, 12, 13]) {
    const state = Y.getState(d.store, c);
    if (state === 0) continue;
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < p.segs; i++) {
      const a = randInt(rnd, 0, state - 1);
      const len = randInt(rnd, 1, state - a);
      const rep = randInt(rnd, 1, 50);
      for (let r = 0; r < rep; r++) ranges.push([a, len]);
    }
    for (let i = ranges.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [ranges[i], ranges[j]] = [ranges[j]!, ranges[i]!];
    }
    entries.push([c, ranges]);
  }
  return { g: "G6", d, u: deleteOnly(entries) };
});

/** G7: explicit ranges over already-cascaded children. */
const g7 = fc.record({ s: seed, k: fc.integer({ min: 1, max: 3000 }), share: fc.integer({ min: 0, max: 100 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const n = nestedDoc(p.k);
  const children = n.childClocks.filter(() => rnd() * 100 < p.share).map((c): [number, number] => [c, 1]);
  return { g: "G7", d: n.doc, u: deleteOnly([[1, [[n.typeItem.id.clock, 1]]], [2, children]]) };
});

/** G8: duplicate format items on sparse clocks (`format-cleanup-k.cjs`). */
const g8 = fc.record({ m: fc.integer({ min: 1, max: 20 }), k: fc.integer({ min: 1, max: 30 }), a: fc.nat(), b: fc.nat() }).map((p): Sample => {
  const f = formatCleanupDoc(p.m, p.k);
  const span = 2 * p.m;
  const from = p.a % span;
  const len = 1 + (p.b % (span - from));
  return { g: "G8", d: f.server, u: deleteOnly([[f.stringClient, [[from, len]]]]) };
});

/** G9: delete-only update entirely beyond the clocks (`pend-growth.cjs`). */
const g9 = fc.record({ s: seed, text: fc.integer({ min: 1, max: 1000 }), ranges: fc.integer({ min: 1, max: 20 }), known: fc.boolean() }).map((p): Sample => {
  const rnd = lcg(p.s);
  const d = new Y.Doc();
  d.clientID = 1;
  d.getText("t").insert(0, "x".repeat(p.text));
  const client = p.known ? 1 : 4242;
  let at = Y.getState(d.store, client) + randInt(rnd, 0, 1000);
  const list: Array<[number, number]> = [];
  for (let i = 0; i < p.ranges; i++) {
    const len = randInt(rnd, 1, 800_000);
    list.push([at, len]);
    at += len + randInt(rnd, 0, 1000);
  }
  return { g: "G9", d, u: deleteOnly([[client, list]]) };
});

/** G10: a struct whose own client's previous update is missing. */
const g10 = fc.record({ s: seed, steps: fc.integer({ min: 2, max: 8 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const base = new Y.Doc();
  base.clientID = 1;
  base.getText("t").insert(0, "base text");
  const x = syncedClient(base, 31);
  const ups: Uint8Array[] = [];
  x.on("update", (u: Uint8Array) => ups.push(u));
  const t = x.getText("t");
  for (let i = 0; i < p.steps; i++) {
    if (rnd() < 0.75 || t.length === 0) t.insert(Math.floor(rnd() * (t.length + 1)), "q".repeat(1 + Math.floor(rnd() * 4)));
    else t.delete(Math.floor(rnd() * t.length), 1);
  }
  const j = randInt(rnd, 0, ups.length - 2);
  const server = reload(base);
  for (let i = 0; i < j; i++) Y.applyUpdate(server, ups[i]!);
  return { g: "G10", d: server, u: ups[j + 1]! };
});

/** G11: the server holds pending content and the update repeats it. */
const g11 = fc.record({ s: seed, ds: fc.boolean(), raw: fc.boolean() }).map((p): Sample => {
  const rnd = lcg(p.s);
  if (p.ds) {
    // The author's delete must reach into the lost insert for pendingDs.
    const world = "W".repeat(randInt(rnd, 1, 20));
    const from = randInt(rnd, 0, 4);
    const sc = dsAdjacent(world, from, randInt(rnd, 5 - from + 1, 5 - from + world.length));
    const pending = sc.server.store.pendingDs;
    if (p.raw && pending) return { g: "G11", d: sc.server, u: Y.convertUpdateFormatV2ToV1(pending) };
    return { g: "G11", d: sc.server, u: sc.echoStep2 };
  }
  const server = structsCasesB().server;
  const pending = server.store.pendingStructs;
  if (p.raw && pending) return { g: "G11", d: server, u: Y.convertUpdateFormatV2ToV1(pending.update) };
  return { g: "G11", d: server, u: handshakeStep2(server, syncedClient(server, 3)) };
});

/** G12: an update that deletes structs it inserts itself. */
const g12 = fc.record({ s: seed, len: fc.integer({ min: 2, max: 10 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const server = new Y.Doc();
  server.getText("t").insert(0, "hello world");
  const c = syncedClient(server, 0x5151);
  const sv = Y.encodeStateVector(server);
  const t = c.getText("t");
  const at = randInt(rnd, 0, t.length);
  t.insert(at, "n".repeat(p.len));
  const from = randInt(rnd, 0, p.len - 1);
  t.delete(at + from, randInt(rnd, 1, p.len - from));
  if (rnd() < 0.5) t.insert(at + from, "m");
  return { g: "G12", d: server, u: Y.encodeStateAsUpdate(c, sv) };
});

/** G13: reconnect SyncStep2 carrying the whole delete set and one edit. */
const g13 = fc.record({ d: g5Base, s: seed }).map((p): Sample => {
  const rnd = lcg(p.s);
  const c = syncedClient(p.d, 0x7e58);
  const nodes = c.getMap<Y.Map<unknown>>("nodes");
  const live = [...nodes.keys()];
  if (live.length > 0) nodes.get(live[Math.floor(rnd() * live.length)]!)?.set("x", 999);
  else {
    const t = c.getText("t");
    t.insert(Math.floor(rnd() * (t.length + 1)), "x");
  }
  return { g: "G13", d: p.d, u: handshakeStep2(p.d, c) };
});

/** G14: deletes next to stored pendingDs (`ds-adjacent.cjs`, S2). */
const g14 = fc.record({ s: seed, s2: fc.boolean() }).map((p): Sample => {
  const rnd = lcg(p.s);
  const memberDelete = (t: Y.Text): void => {
    if (t.length === 0) return;
    const at = randInt(rnd, 0, t.length - 1);
    t.delete(at, randInt(rnd, 1, t.length - at));
  };
  if (p.s2) {
    const sc = s2(memberDelete);
    return { g: "G14", d: sc.server, u: sc.update };
  }
  const world = "W".repeat(randInt(rnd, 1, 20));
  const from = randInt(rnd, 0, 4);
  const sc = dsAdjacent(world, from, randInt(rnd, 5 - from + 1, 5 - from + world.length), memberDelete);
  return { g: "G14", d: sc.server, u: sc.zStep2 };
});

/** G15: stored pendingStructs split into several items (`structs-b2.cjs`). */
const g15 = fc.record({ p1: fc.integer({ min: 0, max: 10 }), p2: fc.integer({ min: 0, max: 15 }), p3: fc.integer({ min: 0, max: 20 }) }).map((p): Sample => {
  const sc = structsB2(p.p1, p.p2, p.p3);
  return { g: "G15", d: sc.server, u: sc.step2 };
});

/** G16: the author supplies the predecessor and edits inside it (S1, S5). */
const g16 = fc.record({ s5: fc.boolean(), a: fc.integer({ min: 0, max: 5 }), b: fc.integer({ min: 0, max: 6 }) }).map((p): Sample => {
  const sc = p.s5 ? s5(p.b) : s1(p.a, p.b);
  return { g: "G16", d: sc.server, u: sc.update };
});

/** G17: two clients whose origins point at each other (`cycle.cjs`). */
const g17 = fc.integer({ min: 1, max: 3000 }).map((len): Sample => {
  const sc = cycle(len);
  return { g: "G17", d: sc.server, u: sc.update };
});

/** G18: a struct depending only on stored pending content (S3, structs-cases C). */
const g18 = fc.record({ c: fc.boolean(), len: fc.integer({ min: 1, max: 2000 }) }).map((p): Sample => {
  const sc = p.c ? structsCasesC(p.len, 1 + (p.len % 8)) : s3(p.len);
  return { g: "G18", d: sc.server, u: sc.update };
});

/**
 * The `fuzz.cjs` / `precheck-fuzz.cjs` history: three clients, twelve steps.
 * @param rnd - The generator.
 * @returns The client docs and every local update in order.
 */
function fuzzHistory(rnd: () => number): { docs: Y.Doc[]; ups: Uint8Array[] } {
  const docs = [0, 1, 2].map((k) => {
    const d = new Y.Doc();
    d.clientID = 10 + k;
    return d;
  });
  const ups: Uint8Array[] = [];
  for (const d of docs) d.on("update", (u: Uint8Array, o: unknown) => { if (o !== "remote") ups.push(u); });
  for (let s = 0; s < 12; s++) {
    const d = docs[Math.floor(rnd() * 3)]!;
    const t = d.getText("t");
    const m = d.getMap("m");
    const r = rnd();
    if (r < 0.45 || t.length === 0) t.insert(Math.floor(rnd() * (t.length + 1)), "x".repeat(1 + Math.floor(rnd() * 4)));
    else if (r < 0.75) {
      const p = Math.floor(rnd() * t.length);
      t.delete(p, 1 + Math.floor(rnd() * Math.min(4, t.length - p)));
    } else if (r < 0.9) {
      const k = "k" + Math.floor(rnd() * 3);
      d.transact(() => {
        const sub = new Y.Map<unknown>();
        m.set(k, sub);
        sub.set("v", s);
      });
    } else m.delete("k" + Math.floor(rnd() * 3));
    if (rnd() < 0.6) {
      const o = docs[Math.floor(rnd() * 3)]!;
      if (o !== d) Y.applyUpdate(o, Y.encodeStateAsUpdate(d, Y.encodeStateVector(o)), "remote");
    }
  }
  return { docs, ups };
}

/** G19: random subsets merged with `Y.mergeUpdates` (Skip), plus `skip-gap.cjs`. */
const g19 = fc.record({ s: seed, skipGap: fc.integer({ min: 0, max: 9 }) }).map((p): Sample => {
  if (p.skipGap === 0) {
    const sc = skipGap();
    return { g: "G19", d: sc.server, u: sc.update };
  }
  const rnd = lcg(p.s);
  const h = fuzzHistory(rnd);
  const s0 = new Y.Doc();
  for (const u of h.ups) if (rnd() < 0.7) Y.applyUpdate(s0, u);
  const server = reload(s0);
  let pick = h.ups.filter(() => rnd() < 0.3);
  if (pick.length === 0) pick = [h.ups[Math.floor(rnd() * h.ups.length)]!];
  return { g: "G19", d: server, u: Y.mergeUpdates(pick) };
});

/** G20: the update fills the gap of a stored pending map overwrite. */
const g20 = fc.integer({ min: 1, max: 3000 }).map((k): Sample => {
  const sc = storedPendingIntegrate(k);
  return { g: "G20", d: sc.server, u: sc.filler };
});

/** G21: the author supplies the clocks stored pendingDs covers. */
const g21 = fc.record({ w: fc.integer({ min: 1, max: 20 }), from: fc.integer({ min: 0, max: 4 }), extra: fc.nat() }).map((p): Sample => {
  const world = "W".repeat(p.w);
  const len = 5 - p.from + 1 + (p.extra % p.w);
  const sc = dsAdjacent(world, p.from, len);
  return { g: "G21", d: sc.server, u: sc.authorStep2 };
});

/** G22: the `fuzz.cjs` total generator. */
const g22 = seed.map((s): Sample => {
  const rnd = lcg(s);
  const h = fuzzHistory(rnd);
  const s0 = new Y.Doc();
  for (const u of h.ups) if (rnd() < 0.7) Y.applyUpdate(s0, u);
  const server = reload(s0);
  if (rnd() < 0.5 || h.ups.length === 0) return { g: "G22", d: server, u: handshakeStep2(server, h.docs[Math.floor(rnd() * 3)]!) };
  let pick = h.ups.filter(() => rnd() < 0.3);
  if (pick.length === 0) pick = [h.ups[Math.floor(rnd() * h.ups.length)]!];
  return { g: "G22", d: server, u: Y.mergeUpdates(pick) };
});

/** G23: inserting format items into formatted text (C-43 shape). */
const g23 = fc.record({ s: seed, reps: fc.integer({ min: 1, max: 100 }), marks: fc.integer({ min: 0, max: 300 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const d = new Y.Doc();
  d.clientID = 1;
  const t = d.getText("t");
  t.insert(0, "abcdefghij".repeat(p.reps));
  for (let i = 0; i < p.marks && 2 * i < t.length; i++) t.format(2 * i, 1, { bold: true });
  const c = syncedClient(d, 2);
  const ct = c.getText("t");
  const from = randInt(rnd, 0, ct.length - 1);
  const len = randInt(rnd, 1, ct.length - from);
  return { g: "G23", d, u: capture(c, () => ct.format(from, len, { italic: true })) };
});

/** G24: deleting nodes. */
const g24 = fc.record({ s: seed, kind: fc.integer({ min: 0, max: 2 }), k: fc.integer({ min: 20, max: 200 }), count: fc.integer({ min: 1, max: 20 }) }).map((p): Sample => {
  const rnd = lcg(p.s);
  const d = p.kind === 0 ? imageNodes(p.k) : p.kind === 1 ? textNodes(p.k) : canvasDoc(p.k * 2, 0.3);
  const c = syncedClient(d, 0x7e59);
  const nodes = c.getMap("nodes");
  const keys = [...nodes.keys()];
  const u = capture(c, () => {
    for (let i = 0; i < p.count && keys.length > 0; i++) nodes.delete(keys.splice(Math.floor(rnd() * keys.length), 1)[0]!);
  });
  return { g: "G24", d, u };
});

/** G1-G24 of spec 4.2, by id. */
export const GENERATORS = {
  G1: g1, G2: g2, G3: g3, G4: g4, G5: g5, G6: g6, G7: g7, G8: g8, G9: g9, G10: g10, G11: g11, G12: g12,
  G13: g13, G14: g14, G15: g15, G16: g16, G17: g17, G18: g18, G19: g19, G20: g20, G21: g21, G22: g22, G23: g23, G24: g24,
} as const;

/** A generator id. */
export type GeneratorId = keyof typeof GENERATORS;
