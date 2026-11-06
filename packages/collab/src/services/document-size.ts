// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size of every loaded Space document and what one update can do to it
 * (inner#1790).
 *
 * `measure` is the exact size: the encoded state plus a charge for the
 * pending content yjs keeps outside it. `analyze` reads an update against the
 * document before it is applied and bounds how much it can grow the
 * encoding, one count per yjs path that changes the encoded size (the table
 * in docs/ARCHITECTURE.md "Canvas collaboration"); whether it would leave new
 * pending content is decided by yjs itself, on a skeleton of the document.
 *
 * The record of a document keeps the last exact size and an upper bound that
 * every admitted update raises; a throttled recompute brings the bound back
 * to the exact size. Each change of phase, and each exact recompute, is
 * pushed to this instance's connections of the document as `doc:size`.
 */

import { DOC_SIZE_EVENT_BYTES, parseDocName, type DocSizeStatus } from "@breatic/shared";
import type { Document } from "@hocuspocus/server";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { getCollabConfig } from "@collab/config.js";

const C = DOC_SIZE_EVENT_BYTES;

type Store = Y.Doc["store"];
type Struct = Y.Item | Y.GC | Y.Skip;
type DeleteSet = ReturnType<typeof Y.createDeleteSet>;
/** Any shared type, typed as the document's own share map holds them. */
type SharedType = NonNullable<ReturnType<Y.Doc["share"]["get"]>>;

/** Half-open clock intervals, `[start, end)`, sorted and disjoint. */
type Ranges = Array<[number, number]>;

/** What one update can do to a document's encoded size. */
export interface UpdateAnalysis {
  /** Most bytes the update can add to `measure`. */
  growthBound: number;
  /** Fewest content bytes the update's deletes free. */
  freedBytes: number;
  /** Structs the update inserts, Skip excluded. */
  structs: number;
  /** Bytes of the update's struct section. */
  structBytes: number;
  /** Delete ranges that cover live content. */
  liveRanges: number;
  /** Range endpoints that fall inside a live item. */
  liveEndpoints: number;
  /** Live items under deleted or replaced types that the update does not delete itself. */
  cascadeItems: number;
  /** Live format items yjs's formatting cleanup may delete. */
  formatItems: number;
  /** Applying the update leaves pending content the document did not hold. */
  wouldPend: boolean;
  /** Applying the update integrates pending content the document holds. */
  integratesStored: boolean;
  /** The update deletes live content. */
  deletesLive: boolean;
  /** The pending check needed a skeleton document. */
  skeletonBuilt: boolean;
  /** A skeleton was built, for the pending check or to see stored pending content integrate. */
  skeletonRan: boolean;
}

/**
 * The bytes of an unsigned varint.
 * @param n - A non-negative integer.
 * @returns Its encoded length.
 */
function varuintLength(n: number): number {
  let length = 1;
  for (let rest = n; rest >= 128; rest = Math.floor(rest / 128)) length++;
  return length;
}

/**
 * The pending content a store holds, Skip excluded.
 * @param store - The document's store.
 * @returns Pending struct and delete-range counts.
 */
function pendingCounts(store: Store): { structs: number; ranges: number } {
  let structs = 0;
  let ranges = 0;
  if (store.pendingStructs) {
    for (const s of Y.decodeUpdateV2(store.pendingStructs.update).structs) if (!(s instanceof Y.Skip)) structs++;
  }
  if (store.pendingDs) Y.decodeUpdateV2(store.pendingDs).ds.clients.forEach((rs) => { ranges += rs.length; });
  return { structs, ranges };
}

/**
 * The exact size of a document: its encoded state plus `C` per stored
 * pending struct and `2C` per stored pending delete range.
 * @param document - The document.
 * @returns The size in bytes.
 */
export function measure(document: Y.Doc): number {
  const pending = pendingCounts(document.store);
  return Y.encodeStateAsUpdate(document).byteLength + C * pending.structs + 2 * C * pending.ranges;
}

/**
 * The encoded length of a V1 update's delete set, as the update wrote it.
 * @param ds - The decoded delete set, in the update's order.
 * @returns Its bytes.
 */
function deleteSetBytes(ds: DeleteSet): number {
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, ds.clients.size);
  ds.clients.forEach((items, client) => {
    encoding.writeVarUint(encoder.restEncoder, client);
    encoding.writeVarUint(encoder.restEncoder, items.length);
    for (const item of items) {
      encoder.writeDsClock(item.clock);
      encoder.writeDsLen(item.len);
    }
  });
  return encoder.toUint8Array().byteLength;
}

/**
 * The clock each client reaches once the update's structs are integrated
 * from the store's state, a struct past a gap reaching nothing; Skip does not
 * extend it.
 * @param structs - The update's structs.
 * @param store - The document's store.
 * @returns Reach per client, and whether any struct starts past a gap.
 */
function reach(structs: Struct[], store: Store): { reached: Map<number, number>; gap: boolean } {
  const reached = new Map<number, number>();
  let gap = false;
  for (const s of structs) {
    const client = s.id.client;
    const at = reached.get(client) ?? Y.getState(store, client);
    if (s instanceof Y.Skip) {
      reached.set(client, at);
      continue;
    }
    if (s.id.clock > at) {
      gap = true;
      reached.set(client, at);
      continue;
    }
    reached.set(client, Math.max(at, s.id.clock + s.length));
  }
  return { reached, gap };
}

/**
 * The ids an item depends on: origin, right origin and parent item.
 * @param s - The struct.
 * @returns Its references.
 */
function refsOf(s: Struct): Y.ID[] {
  if (!(s instanceof Y.Item)) return [];
  const refs: Y.ID[] = [];
  if (s.origin) refs.push(s.origin);
  if (s.rightOrigin) refs.push(s.rightOrigin);
  if (s.parent instanceof Y.ID) refs.push(s.parent);
  return refs;
}

/**
 * Whether applying the update could leave new pending content: a struct past
 * a gap, a reference past the store's clock to another client or forward on
 * its own, or a delete range past what the update reaches. When this is
 * false yjs cannot pend anything from the update.
 * @param update - A V1 update.
 * @param store - The document's store.
 * @returns True when the skeleton has to decide.
 */
export function precheckMayPend(update: Uint8Array, store: Store): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  return mayPend(structs, ds, store, reach(structs, store));
}

/**
 * {@link precheckMayPend} on a decoded update.
 * @param structs - The update's structs.
 * @param ds - The update's delete set.
 * @param store - The document's store.
 * @param reached - The update's reach.
 * @param reached.reached - Reach per client.
 * @param reached.gap - Whether a struct starts past a gap.
 * @returns True when the skeleton has to decide.
 */
function mayPend(structs: Struct[], ds: DeleteSet, store: Store, reached: { reached: Map<number, number>; gap: boolean }): boolean {
  if (reached.gap) return true;
  for (const s of structs) {
    for (const ref of refsOf(s)) {
      if (ref.clock < Y.getState(store, ref.client)) continue;
      if (ref.client !== s.id.client || ref.clock >= s.id.clock) return true;
    }
  }
  let past = false;
  ds.clients.forEach((items, client) => {
    const at = reached.reached.get(client) ?? Y.getState(store, client);
    for (const item of items) if (item.clock + item.len > at) past = true;
  });
  return past;
}

/**
 * Pending units of a store as merged intervals per client, structs and
 * delete ranges kept apart, Skip excluded.
 * @param store - The store.
 * @returns The intervals.
 */
function pendingUnits(store: Store): { structs: Map<number, Ranges>; deletes: Map<number, Ranges> } {
  const structs = new Map<number, Ranges>();
  const deletes = new Map<number, Ranges>();
  if (store.pendingStructs) {
    for (const s of Y.decodeUpdateV2(store.pendingStructs.update).structs) {
      if (!(s instanceof Y.Skip)) pushRange(structs, s.id.client, s.id.clock, s.id.clock + s.length);
    }
  }
  if (store.pendingDs) {
    Y.decodeUpdateV2(store.pendingDs).ds.clients.forEach((items, client) => {
      for (const item of items) pushRange(deletes, client, item.clock, item.clock + item.len);
    });
  }
  for (const map of [structs, deletes]) for (const [client, ranges] of map) map.set(client, mergeRanges(ranges));
  return { structs, deletes };
}

/**
 * Append an interval to a per-client map.
 * @param map - The map.
 * @param client - The client.
 * @param start - First clock.
 * @param end - Clock past the last.
 */
function pushRange(map: Map<number, Ranges>, client: number, start: number, end: number): void {
  const list = map.get(client);
  if (list) list.push([start, end]);
  else map.set(client, [[start, end]]);
}

/**
 * Sort and merge intervals.
 * @param ranges - Intervals in any order.
 * @returns Disjoint intervals in ascending order.
 */
function mergeRanges(ranges: Ranges): Ranges {
  const out: Ranges = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Whether `a` holds clocks `b` does not, per client. Both come from
 * `mergeRanges`, so an interval of `a` is held by `b` only inside one
 * interval of `b`, and one pass over each list decides it.
 * @param a - Disjoint ascending intervals.
 * @param b - Disjoint ascending intervals, touching ones merged.
 * @returns True when some unit of `a` is missing from `b`.
 */
function holdsMore(a: Map<number, Ranges>, b: Map<number, Ranges>): boolean {
  for (const [client, ranges] of a) {
    const other = b.get(client) ?? [];
    let j = 0;
    for (const [x, y] of ranges) {
      while (j < other.length && other[j]![1] <= x) j++;
      const held = other[j];
      if (!held || held[0] > x || held[1] < y) return true;
    }
  }
  return false;
}

/**
 * Decide pending content on a skeleton: one GC run over `[0, state)` for every
 * client the update and the stored pending content touch, plus the stored
 * pending content, so yjs makes the same clock decisions it would make on the
 * document.
 * @param update - A V1 update.
 * @param structs - The update's structs.
 * @param ds - The update's delete set.
 * @param store - The document's store.
 * @returns Whether new pending units appear and stored ones disappear.
 */
function skeletonVerdict(update: Uint8Array, structs: Struct[], ds: DeleteSet, store: Store): { wouldPend: boolean; integratesStored: boolean } {
  const clients = new Set<number>();
  /**
   * Note every client a batch of structs and deletes refers to.
   * @param list - Structs.
   * @param deletes - A delete set.
   */
  const touch = (list: Struct[], deletes: DeleteSet): void => {
    for (const s of list) {
      clients.add(s.id.client);
      for (const ref of refsOf(s)) clients.add(ref.client);
    }
    deletes.clients.forEach((_items, client) => clients.add(client));
  };
  touch(structs, ds);
  const stored = store.pendingStructs ? Y.decodeUpdateV2(store.pendingStructs.update) : null;
  const storedDs = store.pendingDs ? Y.decodeUpdateV2(store.pendingDs) : null;
  if (stored) touch(stored.structs, stored.ds);
  if (storedDs) touch(storedDs.structs, storedDs.ds);

  const runs = [...clients].map((client) => [client, Y.getState(store, client)] as const).filter(([, state]) => state > 0);
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, runs.length);
  for (const [client, state] of runs) {
    encoding.writeVarUint(encoder.restEncoder, 1);
    encoder.writeClient(client);
    encoding.writeVarUint(encoder.restEncoder, 0);
    new Y.GC(Y.createID(client, 0), state).write(encoder, 0);
  }
  encoding.writeVarUint(encoder.restEncoder, 0);

  const skeleton = new Y.Doc();
  try {
    Y.applyUpdate(skeleton, encoder.toUint8Array());
    if (store.pendingStructs) Y.applyUpdateV2(skeleton, store.pendingStructs.update);
    if (store.pendingDs) Y.applyUpdateV2(skeleton, store.pendingDs);
    const before = pendingUnits(skeleton.store);
    Y.applyUpdate(skeleton, update);
    const after = pendingUnits(skeleton.store);
    return {
      wouldPend: holdsMore(after.structs, before.structs) || holdsMore(after.deletes, before.deletes),
      integratesStored: holdsMore(before.structs, after.structs) || holdsMore(before.deletes, after.deletes),
    };
  } finally {
    skeleton.destroy();
  }
}

/**
 * Whether yjs retries stored pending content once the update's structs are
 * in, for an update that cannot pend: it retries stored structs when a
 * missing clock is reached and replays stored deletes up to the new clocks.
 * @param store - The document's store.
 * @param reached - Reach per client after the update.
 * @returns True when a retry runs; false means no stored unit integrates.
 */
function integratesWithoutSkeleton(store: Store, reached: Map<number, number>): boolean {
  if (store.pendingStructs) {
    for (const [client, clock] of store.pendingStructs.missing) if (clock < (reached.get(client) ?? Y.getState(store, client))) return true;
  }
  if (!store.pendingDs) return false;
  let integrates = false;
  Y.decodeUpdateV2(store.pendingDs).ds.clients.forEach((items, client) => {
    const at = reached.get(client);
    if (at !== undefined && items.some((item) => item.clock < at)) integrates = true;
  });
  return integrates;
}

/** The new part of an update's item: clocks the store does not hold yet. */
interface OwnPiece {
  item: Y.Item;
  start: number;
  end: number;
}

/**
 * The first entry of a list in ascending, non-overlapping clock order whose
 * end lies past a clock.
 * @param list - The entries.
 * @param clock - The clock.
 * @param endOf - An entry's end (exclusive).
 * @returns Its index, or the list's length when there is none.
 */
function firstEndingAfter<T>(list: readonly T[], clock: number, endOf: (entry: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (endOf(list[mid]!) <= clock) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Content bytes deleting `[offset, offset + len)` of an item frees at least,
 * net of the length field the deleted run keeps; format items count nothing.
 * @param item - A live item.
 * @param offset - First covered unit within the item.
 * @param len - Covered units.
 * @returns The bytes.
 */
function freedBy(item: Y.Item, offset: number, len: number): number {
  const content = item.content;
  if (content instanceof Y.ContentFormat || content instanceof Y.ContentType) return 0;
  let raw: number;
  if (content instanceof Y.ContentString) {
    raw = Buffer.byteLength(content.str.slice(offset, offset + len), "utf8");
  } else if (offset === 0 && len === item.length) {
    const encoder = new Y.UpdateEncoderV1();
    content.write(encoder, 0);
    raw = encoder.toUint8Array().byteLength;
  } else {
    // ponytail: a partly deleted non-string item frees nothing here; the bound
    // only stays lower, slice its encoding if such deletes ever need credit.
    return 0;
  }
  return Math.max(0, raw - varuintLength(len));
}

/**
 * Bound what one update can do to a document's encoded size, against the
 * document as it is before the update is applied.
 * @param update - A V1 update.
 * @param document - The document.
 * @returns The analysis.
 */
export function analyze(update: Uint8Array, document: Y.Doc): UpdateAnalysis {
  const store = document.store;
  const decoded = Y.decodeUpdate(update);
  const structs = decoded.structs;
  const ds = Y.mergeDeleteSets([decoded.ds]);
  const reached = reach(structs, store);

  let structCount = 0;
  const own = new Map<number, OwnPiece[]>();
  const ownById = new Map<string, Y.Item>();
  for (const s of structs) {
    if (s instanceof Y.Skip) continue;
    structCount++;
    if (!(s instanceof Y.Item)) continue;
    const start = Math.max(s.id.clock, Y.getState(store, s.id.client));
    const end = s.id.clock + s.length;
    if (start >= end) continue;
    const list = own.get(s.id.client);
    if (list) list.push({ item: s, start, end });
    else own.set(s.id.client, [{ item: s, start, end }]);
    ownById.set(`${s.id.client}:${s.id.clock}`, s);
  }
  const structBytes = update.byteLength - deleteSetBytes(decoded.ds);

  /**
   * Find the item holding an id, in the document or among the update's own.
   * @param id - The id.
   * @returns The item, or null.
   */
  const itemAt = (id: Y.ID): Y.Item | null => {
    if (id.clock < Y.getState(store, id.client)) {
      const list = store.clients.get(id.client);
      if (!list) return null;
      const s = list[Y.findIndexSS(list, id.clock)];
      return s instanceof Y.Item ? s : null;
    }
    const pieces = own.get(id.client) ?? [];
    const s = pieces[firstEndingAfter(pieces, id.clock, (p) => p.item.id.clock + p.item.length)]?.item;
    return s && id.clock >= s.id.clock ? s : null;
  };

  // An update's own items anchor on each other in long chains (a paste of many
  // blocks), and the structs are visited in order, so each resolved place is kept.
  const places = new Map<Y.Item, { parent: SharedType; key: string | null }>();
  /**
   * The type an update item goes into and the map key it writes, read the
   * way yjs reads it: from the origin, the right origin, or the item itself.
   * @param s - An update item.
   * @param depth - Guard against reference loops.
   * @returns The parent and key, or null when they cannot be resolved here.
   */
  const placeOf = (s: Y.Item, depth = 0): { parent: SharedType; key: string | null } | null => {
    const known = places.get(s);
    if (known) return known;
    const place = resolvePlace(s, depth);
    if (place) places.set(s, place);
    return place;
  };
  /**
   * {@link placeOf} without the kept results.
   * @param s - An update item.
   * @param depth - Guard against reference loops.
   * @returns The parent and key, or null.
   */
  const resolvePlace = (s: Y.Item, depth: number): { parent: SharedType; key: string | null } | null => {
    if (depth > 64) return null;
    const anchor = s.origin ?? s.rightOrigin;
    if (anchor) {
      const next = itemAt(anchor);
      if (!next) return null;
      if (!ownById.has(`${next.id.client}:${next.id.clock}`)) {
        return next.parent instanceof Y.AbstractType ? { parent: next.parent, key: next.parentSub } : null;
      }
      return placeOf(next, depth + 1);
    }
    if (typeof s.parent === "string") {
      const root = document.share.get(s.parent);
      return root ? { parent: root, key: s.parentSub } : null;
    }
    if (s.parent instanceof Y.ID) {
      const holder = itemAt(s.parent);
      return holder?.content instanceof Y.ContentType ? { parent: holder.content.type, key: s.parentSub } : null;
    }
    return null;
  };

  // A struct written to a map key deletes the value it replaces while it
  // integrates, before yjs applies the delete set, so a range over that value
  // finds it deleted already (its event is the struct's `C`).
  const replaced = new Set<Y.Item>();
  const deletedTypes: SharedType[] = [];
  const formatTexts = new Set<Y.Text>();
  /**
   * Note a text whose formatting yjs may clean up after the update.
   * @param parent - The type an affected item sits in.
   */
  const noteText = (parent: unknown): void => {
    if (parent instanceof Y.Text && parent._hasFormatting) formatTexts.add(parent);
  };
  for (const s of structs) {
    if (!(s instanceof Y.Item) || !ownById.has(`${s.id.client}:${s.id.clock}`)) continue;
    const place = placeOf(s);
    if (!place) continue;
    if (s.content instanceof Y.ContentFormat) noteText(place.parent);
    if (place.key === null) continue;
    const current = place.parent._map.get(place.key);
    if (!current || current.deleted || ownById.has(`${current.id.client}:${current.id.clock}`)) continue;
    replaced.add(current);
    if (current.content instanceof Y.ContentType) deletedTypes.push(current.content.type);
  }

  let liveRanges = 0;
  let liveEndpoints = 0;
  let freedBytes = 0;

  ds.clients.forEach((items, client) => {
    const state = Y.getState(store, client);
    const list = store.clients.get(client);
    for (const { clock, len } of items) {
      const end = clock + len;
      let live = false;
      if (list && clock < state) {
        for (let i = Y.findIndexSS(list, clock); i < list.length; i++) {
          const s = list[i]!;
          if (s.id.clock >= end) break;
          if (!(s instanceof Y.Item) || s.deleted || replaced.has(s)) continue;
          live = true;
          const from = Math.max(clock, s.id.clock);
          const to = Math.min(end, s.id.clock + s.length);
          if (s.id.clock < clock) liveEndpoints++;
          if (s.id.clock + s.length > end) liveEndpoints++;
          freedBytes += freedBy(s, from - s.id.clock, to - from);
          if (s.content instanceof Y.ContentType) deletedTypes.push(s.content.type);
          noteText(s.parent);
        }
      }
      const pieces = own.get(client) ?? [];
      for (let i = firstEndingAfter(pieces, clock, (p) => p.end); i < pieces.length && pieces[i]!.start < end; i++) {
        const piece = pieces[i]!;
        live = true;
        if (piece.start < clock) liveEndpoints++;
        if (piece.end > end) liveEndpoints++;
        noteText(placeOf(piece.item)?.parent);
      }
      if (live) liveRanges++;
    }
  });

  /**
   * Whether the update's own delete ranges cover all of an item.
   * @param item - A document item.
   * @returns True when it is deleted by the update itself.
   */
  const coveredByUpdate = (item: Y.Item): boolean => {
    const ranges = ds.clients.get(item.id.client) ?? [];
    const r = ranges[firstEndingAfter(ranges, item.id.clock, (range) => range.clock + range.len)];
    return r !== undefined && r.clock <= item.id.clock && item.id.clock + item.length <= r.clock + r.len;
  };

  let cascadeItems = 0;
  const visited = new Set<Y.Item>();
  const stack = [...deletedTypes];
  while (stack.length > 0) {
    const type = stack.pop()!;
    const children: Y.Item[] = [];
    for (let it = type._start; it; it = it.right) children.push(it);
    type._map.forEach((it) => children.push(it));
    for (const child of children) {
      if (child.deleted || visited.has(child)) continue;
      visited.add(child);
      if (!coveredByUpdate(child)) cascadeItems++;
      if (child.content instanceof Y.ContentType) stack.push(child.content.type);
    }
  }

  let formatItems = 0;
  for (const text of formatTexts) {
    for (let it = text._start; it; it = it.right) if (!it.deleted && it.content instanceof Y.ContentFormat) formatItems++;
  }

  const skeletonBuilt = mayPend(structs, ds, store, reached);
  // A reached missing clock makes yjs retry the stored pending content, which
  // may still need clocks past what the update brings; only the skeleton
  // tells whether any of it integrates.
  const skeletonRan = skeletonBuilt || integratesWithoutSkeleton(store, reached.reached);
  const verdict = skeletonRan
    ? skeletonVerdict(update, structs, ds, store)
    : { wouldPend: false, integratesStored: false };

  const growthBound =
    (structCount > 0 ? structBytes + C * structCount : 0) + C * (liveEndpoints + liveRanges + cascadeItems + formatItems);

  return {
    growthBound,
    freedBytes,
    structs: structCount,
    structBytes,
    liveRanges,
    liveEndpoints,
    cascadeItems,
    formatItems,
    wouldPend: skeletonBuilt && verdict.wouldPend,
    integratesStored: verdict.integratesStored,
    deletesLive: liveRanges > 0,
    skeletonBuilt,
    skeletonRan,
  };
}

/**
 * The pending content a store holds, as a comparable key; "" for none.
 * @param store - The store.
 * @returns The key.
 */
function pendingKey(store: Store): string {
  if (!store.pendingStructs && !store.pendingDs) return "";
  const units = pendingUnits(store);
  /**
   * A per-client map as entries in client order.
   * @param m - The map.
   * @returns Its entries, sorted.
   */
  const sorted = (m: Map<number, Ranges>): Array<[number, Ranges]> => [...m].sort((a, b) => a[0] - b[0]);
  return JSON.stringify([sorted(units.structs), sorted(units.deletes)]);
}

/**
 * Raise a document's upper bound for an update that is already applied and
 * did not come from a client connection (another instance, collab's own
 * writes, yjs's formatting cleanup), so no pre-update state is left to read:
 * the whole update plus `C` per struct, and `3C` per delete range.
 * @param name - The document name.
 * @param update - The applied V1 update.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function addAppliedBound(name: string, update: Uint8Array): void {
  if (!records.has(name)) return;
  const { structs, ds } = Y.decodeUpdate(update);
  const count = structs.filter((s) => !(s instanceof Y.Skip)).length;
  let ranges = 0;
  ds.clients.forEach((items) => { ranges += items.length; });
  addUpperBound(name, (count > 0 ? update.byteLength + C * count : 0) + 3 * C * ranges);
}

/**
 * After every transaction on a recorded document: content that only pends
 * emits no update, so no bound sees it. A client connection's admitted
 * update never adds pending content (it may integrate some); any other
 * transaction that changed it gets the size measured again at once.
 * @param name - The document name.
 * @param record - Its record.
 * @param origin - The transaction's origin.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function afterTransaction(name: string, record: SizeRecord, origin: unknown): void {
  if (records.get(name) !== record) return;
  const from = origin as { source?: unknown; connection?: unknown } | null;
  // An admitted update has landed; a measure taken while it was on its way
  // could not see it, so measure again now that it is in.
  if (from?.source === "connection" && record.unapplied.delete(from.connection) && record.remeasure) {
    scheduleRecompute(name, record);
  }
  const key = pendingKey(record.document.store);
  if (key === record.pendingKey) return;
  if ((origin as { source?: unknown } | null)?.source === "connection") record.pendingKey = key;
  else recordExact(name, measure(record.document));
}

/** The phase a size is in. */
export type DocSizePhase = DocSizeStatus["phase"];

/** One loaded document's size record. */
interface SizeRecord {
  document: Document;
  exact: number;
  upper: number;
  phase: DocSizePhase;
  measuredAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The pending content when the size was last known, see {@link pendingKey}. */
  pendingKey: string;
  /** Its `afterTransaction` listener. */
  listener: (transaction: Y.Transaction) => void;
  /**
   * Admitted client updates not applied yet, by connection, with what each
   * can still add: Hocuspocus applies an update only once every `beforeSync`
   * step has finished, and a measure taken before then cannot see it.
   */
  unapplied: Map<unknown, number>;
  /** The last exact measure ran while an admitted update was on its way. */
  remeasure: boolean;
}

const records = new Map<string, SizeRecord>();

/**
 * The limits the configuration sets.
 * @returns Limit, hard ceiling, warning and full lines, overwrite reserve.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function limits(): { limit: number; ceiling: number; warnFrom: number; fullAt: number; reserve: number; intervalMs: number } {
  const cfg = getCollabConfig();
  const limit = cfg.max_document_bytes;
  return {
    limit,
    ceiling: limit + cfg.document_size_delete_headroom_bytes,
    warnFrom: limit * cfg.document_size_warn_ratio,
    fullAt: limit - cfg.document_size_full_margin_bytes,
    reserve: cfg.document_size_overwrite_reserve_bytes,
    intervalMs: cfg.document_size_measure_interval_ms,
  };
}

/**
 * The phase of a size.
 * @param bytes - The size.
 * @returns Its phase.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function phaseOf(bytes: number): DocSizePhase {
  const l = limits();
  if (bytes >= l.fullAt) return "full";
  return bytes >= l.warnFrom ? "warning" : "normal";
}

/**
 * The `doc:size` message for a document, its bytes the record's upper bound;
 * with no record the deployment sets no limit and every number is 0.
 * @param name - The document name.
 * @returns The message.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function docSizeStatus(name: string): DocSizeStatus {
  const record = records.get(name);
  if (!record) return { type: "doc:size", bytes: 0, limit: 0, ceiling: 0, room: 0, overwriteRoom: 0, phase: "normal" };
  const l = limits();
  return {
    type: "doc:size",
    bytes: record.upper,
    limit: l.limit,
    ceiling: l.ceiling,
    room: Math.max(0, l.fullAt - record.upper),
    overwriteRoom: Math.max(0, l.ceiling - record.upper - l.reserve),
    phase: record.phase,
  };
}

/**
 * Send the document's `doc:size` to one connection.
 * @param name - The document name.
 * @param connection - The connection.
 * @param connection.sendStateless - Its stateless channel.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function pushDocSize(name: string, connection: { sendStateless: (payload: string) => void }): void {
  connection.sendStateless(JSON.stringify(docSizeStatus(name)));
}

/**
 * Send the record's `doc:size` to every connection of the document on this
 * instance.
 * @param name - The document name.
 * @param record - Its record.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function pushAll(name: string, record: SizeRecord): void {
  const payload = JSON.stringify(docSizeStatus(name));
  for (const connection of record.document.getConnections()) connection.sendStateless(payload);
}

/**
 * Whether a document gets a size record: a Space content document while the
 * deployment sets a limit.
 * @param name - The document name.
 * @returns True when it is tracked.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function tracksSize(name: string): boolean {
  const parsed = parseDocName(name);
  return parsed !== null && parsed.kind !== "meta" && getCollabConfig().max_document_bytes > 0;
}

/**
 * Start the record of a loaded document at its exact size.
 * @param document - The Hocuspocus document; pushes go to its connections.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function openDocSizeRecord(document: Document): void {
  if (!tracksSize(document.name)) return;
  forget(document.name);
  const bytes = measure(document);
  const name = document.name;
  const record: SizeRecord = {
    document, exact: bytes, upper: bytes, phase: phaseOf(bytes), measuredAt: Date.now(), timer: null, pendingKey: pendingKey(document.store),
    listener: (transaction) => afterTransaction(name, record, transaction.origin),
    unapplied: new Map(), remeasure: false,
  };
  records.set(name, record);
  document.on("afterTransaction", record.listener);
}

/**
 * Set a document's exact size; the upper bound starts again from it, plus
 * what the admitted updates not applied yet can add.
 * @param name - The document name.
 * @param bytes - The exact size.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function recordExact(name: string, bytes: number): void {
  const record = records.get(name);
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);
  record.timer = null;
  let unapplied = 0;
  for (const bound of record.unapplied.values()) unapplied += bound;
  record.exact = bytes;
  record.upper = bytes + unapplied;
  record.phase = phaseOf(record.upper);
  record.remeasure = record.unapplied.size > 0;
  record.measuredAt = Date.now();
  record.pendingKey = pendingKey(record.document.store);
  pushAll(name, record);
}

/**
 * Raise a document's upper bound by what an admitted update can add, and
 * schedule an exact recompute at most once per measure interval.
 * @param name - The document name.
 * @param bound - Bytes the update can add.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
export function addUpperBound(name: string, bound: number): void {
  const record = records.get(name);
  if (!record) return;
  record.upper += bound;
  const phase = phaseOf(record.upper);
  if (phase !== record.phase) {
    record.phase = phase;
    pushAll(name, record);
  }
  scheduleRecompute(name, record);
}

/**
 * Note an update `beforeSync` admitted, which Hocuspocus applies once the
 * remaining `beforeSync` steps have finished.
 * @param name - The document name.
 * @param connection - The connection it came on; Hocuspocus handles one message per connection at a time.
 * @param bound - Most bytes it can add to the exact size measured before it lands.
 */
export function holdUntilApplied(name: string, connection: unknown, bound: number): void {
  records.get(name)?.unapplied.set(connection, bound);
}

/**
 * What the admitted updates of every other connection, not applied yet, can
 * still add.
 * @param name - The document name.
 * @param connection - The connection left out.
 * @returns Bytes.
 */
export function unappliedBesides(name: string, connection: unknown): number {
  let bytes = 0;
  for (const [held, bound] of records.get(name)?.unapplied ?? []) if (held !== connection) bytes += bound;
  return bytes;
}

/**
 * Forget a connection's admitted update once Hocuspocus has handled its
 * message; one it applied is gone already, one it did not apply never lands.
 * @param name - The document name.
 * @param connection - The connection it came on.
 */
export function dropUnapplied(name: string, connection: unknown): void {
  const record = records.get(name);
  // An applied update was dropped when it landed; one still here never will,
  // and the size recorded with it in mind has to be measured again.
  if (record?.unapplied.delete(connection)) scheduleRecompute(name, record);
}

/**
 * Schedule an exact recompute at most once per measure interval.
 * @param name - The document name.
 * @param record - Its record.
 * @throws {Error} When the YAML is missing / unreadable or fails validation.
 */
function scheduleRecompute(name: string, record: SizeRecord): void {
  if (record.timer) return;
  const delay = Math.max(0, record.measuredAt + limits().intervalMs - Date.now());
  record.timer = setTimeout(() => {
    record.timer = null;
    if (records.get(name) === record) recordExact(name, measure(record.document));
  }, delay);
  record.timer.unref?.();
}

/**
 * Drop a document's record when it unloads.
 * @param name - The document name.
 */
export function forget(name: string): void {
  const record = records.get(name);
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);
  record.document.off("afterTransaction", record.listener);
  records.delete(name);
}

/**
 * A document's record, as tests and the size gate read it.
 * @param name - The document name.
 * @returns Exact size, upper bound and phase, or undefined with no record.
 */
export function readDocSizeRecord(name: string): { exact: number; upper: number; phase: DocSizePhase } | undefined {
  const record = records.get(name);
  return record && { exact: record.exact, upper: record.upper, phase: record.phase };
}
