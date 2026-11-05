// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Document builders and reference measurements for the document size cap
 * tests (inner#1790). Every builder here follows the test spec's construction
 * table (section 0.3) and the probe it names, so a case that cites a shape
 * gets the same bytes the spec's truth values were measured on.
 *
 * `refMeasure` is the test-side recomputation of `measure` (spec 0.2): the
 * encoded state plus `C` per stored pending struct (Skip excluded) and `2C` per
 * stored pending delete range. Assertions compare production records against
 * it, never against a number the production module produced.
 */

import { DOC_SIZE_EVENT_BYTES } from "@breatic/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/** The spec's `C`, read from the shared contract rather than written down. */
export const C: number = DOC_SIZE_EVENT_BYTES;

/** The client id `fill` writes with unless told otherwise. */
export const FILL_CLIENT = 0xf00000aa;

/**
 * Count the non-Skip structs and the delete ranges a document holds as pending.
 * @param doc - The document whose store is read.
 * @returns Pending struct count `p` and pending delete range count `q`.
 */
export function pendingCounts(doc: Y.Doc): { p: number; q: number } {
  let p = 0;
  let q = 0;
  const structs = doc.store.pendingStructs;
  if (structs) {
    p = Y.decodeUpdateV2(structs.update).structs.filter((s) => s.constructor.name !== "Skip").length;
  }
  const ds = doc.store.pendingDs;
  if (ds) {
    Y.decodeUpdateV2(ds).ds.clients.forEach((ranges) => {
      q += ranges.length;
    });
  }
  return { p, q };
}

/**
 * The spec's `ref.measure`: encoded state plus the pending surcharge.
 * @param doc - The document to measure.
 * @returns Bytes.
 */
export function refMeasure(doc: Y.Doc): number {
  const { p, q } = pendingCounts(doc);
  return Y.encodeStateAsUpdate(doc).byteLength + C * p + 2 * C * q;
}

/**
 * A fresh document holding everything `doc` holds, pending content included,
 * the way collab stores and reloads it.
 * @param doc - The source document.
 * @returns The reloaded copy.
 */
export function reload(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

/**
 * Apply an update to a reloaded copy and measure the result, leaving `doc` as it is.
 * @param doc - The server document before the update.
 * @param update - The V1 update.
 * @returns The reference measure of the copy after applying.
 */
export function refMeasureAfter(doc: Y.Doc, update: Uint8Array): number {
  const copy = reload(doc);
  Y.applyUpdate(copy, update);
  const bytes = refMeasure(copy);
  copy.destroy();
  return bytes;
}

/**
 * The state vector `doc` would have after applying `update`.
 * @param doc - The server document.
 * @param update - The V1 update.
 * @returns The encoded state vector.
 */
export function stateVectorAfter(doc: Y.Doc, update: Uint8Array): Uint8Array {
  const copy = reload(doc);
  Y.applyUpdate(copy, update);
  const sv = Y.encodeStateVector(copy);
  copy.destroy();
  return sv;
}

/**
 * Spec 0.3 `fill`: append `'x'` to `getText('t')` until the reference measure
 * sits just under `target`.
 * @param doc - The document to grow.
 * @param target - The size aimed for.
 * @param client - The client id the text is written under.
 * @returns The measured size afterwards (cases assert against this, not `target`).
 */
export function fill(doc: Y.Doc, target: number, client = FILL_CLIENT): number {
  doc.clientID = client;
  const text = doc.getText("t");
  while (refMeasure(doc) + 65_600 <= target) text.insert(text.length, "x".repeat(65_536));
  const rest = target - refMeasure(doc) - 16;
  if (rest > 0) text.insert(text.length, "x".repeat(rest));
  return refMeasure(doc);
}

/**
 * Spec 0.3 `handshakeStep2`: the SyncStep2 payload an honest client answers
 * the server's SyncStep1 with.
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
 * A client fully synced with `doc`.
 * @param doc - The document to copy.
 * @param clientId - The client id the copy writes under, when it matters.
 * @returns The client document.
 */
export function syncedClient(doc: Y.Doc, clientId?: number): Y.Doc {
  const client = new Y.Doc();
  if (clientId !== undefined) client.clientID = clientId;
  Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
  return client;
}

/**
 * Run one transaction on a client and return the update it emitted, as a live
 * client would send it.
 * @param client - The client document.
 * @param edit - The edit, run inside one transaction.
 * @returns The V1 update of that transaction.
 * @throws {Error} When the edit changed nothing.
 */
export function capture(client: Y.Doc, edit: (doc: Y.Doc) => void): Uint8Array {
  let update: Uint8Array | undefined;
  const listener = (u: Uint8Array): void => {
    update = update ? Y.mergeUpdates([update, u]) : u;
  };
  client.on("update", listener);
  client.transact(() => edit(client));
  client.off("update", listener);
  if (!update) throw new Error("the edit emitted no update");
  return update;
}

/**
 * One edit by a fresh client synced with `doc`.
 * @param doc - The server document.
 * @param edit - The edit, run in one transaction.
 * @param clientId - Optional client id.
 * @returns The V1 update.
 */
export function editUpdate(doc: Y.Doc, edit: (client: Y.Doc) => void, clientId?: number): Uint8Array {
  const client = syncedClient(doc, clientId);
  const update = capture(client, edit);
  client.destroy();
  return update;
}

/**
 * A fresh client appends `n` copies of `ch` at the end of `getText('t')`.
 * @param doc - The server document.
 * @param n - How many characters.
 * @param ch - Which character.
 * @returns The V1 update.
 */
export function appendUpdate(doc: Y.Doc, n: number, ch = "y"): Uint8Array {
  return editUpdate(doc, (c) => {
    const t = c.getText("t");
    t.insert(t.length, ch.repeat(n));
  });
}

/**
 * A V1 update with no structs and the given delete ranges, written by hand so
 * the ranges can lie anywhere (spec G9, `pend-growth.cjs`, `preload-pend.cjs`).
 * @param ranges - `[client, clock, length]` triples; one client may repeat.
 * @returns The V1 update.
 */
export function pureDeleteUpdate(ranges: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const byClient = new Map<number, Array<readonly [number, number]>>();
  for (const [client, clock, len] of ranges) {
    const list = byClient.get(client) ?? [];
    list.push([clock, len]);
    byClient.set(client, list);
  }
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, 0);
  encoding.writeVarUint(enc.restEncoder, byClient.size);
  for (const [client, list] of byClient) {
    encoding.writeVarUint(enc.restEncoder, client);
    encoding.writeVarUint(enc.restEncoder, list.length);
    for (const [clock, len] of list) {
      enc.writeDsClock(clock);
      enc.writeDsLen(len);
    }
  }
  return enc.toUint8Array();
}

/**
 * Spec G9 as C-80 and C-82 use it: a pure delete of client 9999 `[0, 10)`,
 * a client no server here has seen.
 * @returns The V1 update.
 */
export function g9Update(): Uint8Array {
  return pureDeleteUpdate([[9999, 0, 10]]);
}

/**
 * C-46 (a), `pend-growth.cjs`: no structs, `n` one-clock ranges of client
 * 4242 starting at clock 1 000 000, all beyond any clock a server holds.
 * @param n - Range count (the probe's default 200 000 is about 800 KB).
 * @returns The V1 update.
 */
export function pendGrowthUpdate(n = 200_000): Uint8Array {
  const ranges: Array<readonly [number, number, number]> = [];
  for (let i = 0; i < n; i++) ranges.push([4242, 1_000_000 + 2 * i, 1]);
  return pureDeleteUpdate(ranges);
}

/**
 * C-46 (g), `preload-pend.cjs`: client 4242 `[1 000 000, 2 000 000)`.
 * @returns The V1 update the probe sent as a SyncStep2 payload.
 */
export function preloadPendUpdate(): Uint8Array {
  return pureDeleteUpdate([[4242, 1_000_000, 1_000_000]]);
}

/**
 * C-46 (c), `cycle.cjs`: clients 21 and 22 each insert 3000 `'Q'` whose origin
 * is the other's new struct.
 * @returns The V1 update.
 */
export function cycleUpdate(): Uint8Array {
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, 2);
  for (const [me, other] of [[22, 21], [21, 22]] as const) {
    encoding.writeVarUint(enc.restEncoder, 1);
    enc.writeClient(me);
    encoding.writeVarUint(enc.restEncoder, 0);
    enc.writeInfo(0x80 | 4);
    enc.writeLeftID(Y.createID(other, 0));
    enc.writeString("Q".repeat(3000));
  }
  encoding.writeVarUint(enc.restEncoder, 0);
  return enc.toUint8Array();
}

/**
 * C-30: client 1 wrote `'hello'` into `getText('t')`.
 * @returns The document.
 */
export function helloDoc(): Y.Doc {
  const d = new Y.Doc();
  d.clientID = 1;
  d.getText("t").insert(0, "hello");
  return d;
}

/**
 * C-32, `stored-pending-loop.cjs` mode ds: `'existing content;'` plus a stored
 * pending delete range of client 4242 `[100, 105)`, reloaded.
 * @returns The reloaded document, which holds `pendingDs`.
 */
export function storedPendingDsDoc(): Y.Doc {
  const d = new Y.Doc();
  d.clientID = 11;
  d.getText("t").insert(0, "existing content;");
  Y.applyUpdate(d, pureDeleteUpdate([[4242, 100, 5]]));
  return reload(d);
}

/**
 * `stored-pending-loop.cjs` mode structs: X:5-9 stored while X:0-4 never arrived.
 * @returns The reloaded document, which holds `pendingStructs`.
 */
export function storedPendingStructsDoc(): Y.Doc {
  const a = new Y.Doc();
  a.clientID = 11;
  a.getText("t").insert(0, "existing content");
  const b = syncedClient(a, 22);
  b.getText("t").insert(3, "XXXXX");
  const sv1 = Y.encodeStateVector(b);
  b.getText("t").insert(8, "YYYYY");
  const u2 = Y.encodeStateAsUpdate(b, sv1);
  const server = reload(a);
  Y.applyUpdate(server, u2);
  return reload(server);
}

/**
 * Spec S1 (`wouldpend-def.cjs`): author X's `'abc'` was lost, `'def'` reached
 * the server as stored pending structs; offline the author deleted one char
 * and typed one.
 * @returns The reloaded server and the author's reconnect SyncStep2 payload.
 */
export function s1Scenario(): { server: Y.Doc; reconnect: Uint8Array } {
  const x = new Y.Doc();
  x.clientID = 777;
  const t = x.getText("t");
  t.insert(0, "abc");
  const sv1 = Y.encodeStateVector(x);
  t.insert(3, "def");
  const srv0 = new Y.Doc();
  Y.applyUpdate(srv0, Y.encodeStateAsUpdate(x, sv1));
  const server = reload(srv0);
  t.delete(4, 1);
  t.insert(5, "g");
  return { server, reconnect: Y.encodeStateAsUpdate(x, Y.encodeStateVector(server)) };
}

/**
 * `stored-pending-integrate.cjs`: `m.x` is a `Y.Array` with `k` sparse-clock
 * children (client 2), a stored pending overwrite of `m.x` by client 3 at
 * clock 1, and the 16-byte gap filler (client 3 clock 0) that integrates it.
 * @param k - Child count.
 * @returns The reloaded server (holding `pendingStructs`) and the gap filler.
 */
export function storedPendingIntegrateScenario(k = 2000): { server: Y.Doc; filler: Uint8Array } {
  const big = 2 ** 40;
  const d = new Y.Doc();
  d.clientID = 1;
  const arr = new Y.Array<number>();
  d.getMap("m").set("x", arr);
  arr.push([0]);
  d.getArray("g").push([0]);
  const typeItem = d.getMap("m")._map.get("x");
  const anchor = arr._start;
  const ganchor = d.getArray("g")._start;
  if (!typeItem || !anchor || !ganchor) throw new Error("fixture items missing");
  const enc = new Y.UpdateEncoderV1();
  encoding.writeVarUint(enc.restEncoder, 1);
  encoding.writeVarUint(enc.restEncoder, 1 + 2 * k);
  enc.writeClient(2);
  encoding.writeVarUint(enc.restEncoder, 0);
  new Y.GC(Y.createID(2, 0), big).write(enc, 0);
  for (let i = 0; i < k; i++) {
    new Y.Item(Y.createID(2, big + 2 * i), null, anchor.id, null, null, null, null, new Y.ContentBinary(new Uint8Array(0))).write(enc, 0);
    new Y.Item(Y.createID(2, big + 2 * i + 1), null, ganchor.id, null, null, null, null, new Y.ContentBinary(new Uint8Array(0))).write(enc, 0);
  }
  encoding.writeVarUint(enc.restEncoder, 0);
  Y.applyUpdate(d, enc.toUint8Array());
  const e2 = new Y.UpdateEncoderV1();
  encoding.writeVarUint(e2.restEncoder, 1);
  encoding.writeVarUint(e2.restEncoder, 1);
  e2.writeClient(3);
  encoding.writeVarUint(e2.restEncoder, 1);
  new Y.Item(Y.createID(3, 1), null, typeItem.lastId, null, null, null, null, new Y.ContentAny([1])).write(e2, 0);
  encoding.writeVarUint(e2.restEncoder, 0);
  Y.applyUpdate(d, e2.toUint8Array());
  const server = reload(d);
  let last = server.getArray("g")._start;
  while (last?.right) last = last.right;
  if (!last) throw new Error("fixture array empty");
  const e3 = new Y.UpdateEncoderV1();
  encoding.writeVarUint(e3.restEncoder, 1);
  encoding.writeVarUint(e3.restEncoder, 1);
  e3.writeClient(3);
  encoding.writeVarUint(e3.restEncoder, 0);
  new Y.Item(Y.createID(3, 0), null, last.lastId, null, null, null, null, new Y.ContentAny([7])).write(e3, 0);
  encoding.writeVarUint(e3.restEncoder, 0);
  return { server, filler: e3.toUint8Array() };
}

/**
 * `node-delete-bound.cjs` `build`: `k` canvas nodes under `nodes`, each moved three times.
 * @param kind - `'image'` or `'text'` (text nodes carry a body).
 * @param k - Node count.
 * @param into - The document to build into.
 * @returns `into`.
 */
export function buildNodes(kind: "image" | "text", k: number, into: Y.Doc = new Y.Doc()): Y.Doc {
  into.clientID = FILL_CLIENT;
  const nodes = into.getMap<Y.Map<unknown>>("nodes");
  for (let i = 0; i < k; i++) {
    into.transact(() => {
      const n = new Y.Map<unknown>();
      nodes.set(`node-${i}`, n);
      n.set("type", kind);
      n.set("x", i * 10.5);
      n.set("y", i * 3.25);
      n.set("w", 320);
      n.set("h", 240);
      n.set("name", `Image ${i}`);
      n.set("url", `https://cdn.example.com/assets/${"f".repeat(64)}.png`);
      const data = new Y.Map<unknown>();
      n.set("data", data);
      data.set("status", "done");
      data.set("model", "model-x");
      if (kind === "text") {
        const body = new Y.Text();
        n.set("body", body);
        body.insert(0, "lorem ipsum ".repeat(40));
      }
    });
  }
  for (let r = 0; r < 3; r++) {
    for (let i = 0; i < k; i++) into.transact(() => nodes.get(`node-${i}`)?.set("x", r + i));
  }
  return into;
}

/**
 * Spec `imageNodes(k)`.
 * @param k - Node count.
 * @returns The document.
 */
export function imageNodes(k: number): Y.Doc {
  return buildNodes("image", k);
}

/**
 * Spec `canvasDoc(n, del)` (`reconnect-bound-canvas.mjs`).
 * @param n - Node count.
 * @param del - Share of nodes deleted, by `(i * 7919 mod n) / n < del`.
 * @returns The document.
 */
export function canvasDoc(n: number, del: number): Y.Doc {
  const d = new Y.Doc();
  const nodes = d.getMap<Y.Map<unknown>>("nodes");
  for (let i = 0; i < n; i++) {
    const node = new Y.Map<unknown>();
    nodes.set(`n${i}`, node);
    node.set("x", i);
    node.set("y", i);
    const body = new Y.Text();
    node.set("body", body);
    body.insert(0, `text of node ${i}`);
    for (let k = 0; k < 5; k++) node.set("x", i + k);
  }
  for (let i = 0; i < n; i++) if (((i * 7919) % n) / n < del) nodes.delete(`n${i}`);
  return d;
}

/**
 * Spec `fragText(k)` (`reconnect-offline-bound.mjs`): fragmented text in `getText('t')`.
 * @param k - Insert count.
 * @param into - The document to build into.
 * @returns `into`.
 */
export function fragText(k: number, into: Y.Doc = new Y.Doc()): Y.Doc {
  const t = into.getText("t");
  for (let i = 0; i < k; i++) {
    const pos = (i * 7919) % (t.length + 1);
    t.insert(pos, "w");
    if (i % 8 === 7) t.delete(pos, 1);
  }
  return into;
}

/**
 * Count the structs and delete ranges of a V1 update.
 * @param update - The update.
 * @returns Struct count (Skip excluded) and delete range count.
 */
export function updateShape(update: Uint8Array): { structs: number; ranges: number } {
  const decoded = Y.decodeUpdate(update);
  let ranges = 0;
  decoded.ds.clients.forEach((list) => {
    ranges += list.length;
  });
  return { structs: decoded.structs.filter((s) => s.constructor.name !== "Skip").length, ranges };
}

/**
 * Spec C-112 bound for a non-connection update reaching `onChange`.
 * @param update - The V1 update.
 * @returns `(structs > 0 ? byteLength + C * structs : 0) + 3C * ranges`.
 */
export function onChangeBound(update: Uint8Array): number {
  const { structs, ranges } = updateShape(update);
  return (structs > 0 ? update.byteLength + C * structs : 0) + 3 * C * ranges;
}

/**
 * Whether two encoded state vectors are equal.
 * @param a - One.
 * @param b - The other.
 * @returns Equal.
 */
export function sameStateVector(a: Uint8Array, b: Uint8Array): boolean {
  const ma = Y.decodeStateVector(a);
  const mb = Y.decodeStateVector(b);
  if (ma.size !== mb.size) return false;
  for (const [client, clock] of ma) if (mb.get(client) !== clock) return false;
  return true;
}
