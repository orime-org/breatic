// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

// Its own subpath entry (`@breatic/shared/update-shape`): it imports yjs,
// which must stay out of web's entry chunk.
import * as Y from "yjs";

/** What an update holds, read against a document's struct store. */
export interface UpdateShape {
  /** The update carries no struct group: it only deletes. */
  pureDelete: boolean;
  /** Delete range ends falling inside a live item, which splits it. */
  splitEndpoints: number;
  /** Delete ranges ending past the store's clock of their client (they pend). */
  beyondClockRanges: number;
  /**
   * Every live item the deletes cover either is covered whole and is a Y
   * type or a Map entry, or sits under a type item this update deletes
   * whole. True when the deletes cover no live item.
   */
  wholeTypesOnly: boolean;
  /** The deletes cover at least one live item. */
  coversLive: boolean;
}

/** One delete range. */
interface Range {
  clock: number;
  len: number;
}

/**
 * Whether an update's first varuint, its struct group count, is 0.
 * @param update - A V1 update.
 * @returns True for an update carrying no structs.
 */
function startsWithZero(update: Uint8Array): boolean {
  return update.length > 0 && update[0] === 0;
}

/**
 * A client's delete ranges sorted by clock with overlapping and adjacent ones
 * merged, as yjs's `sortAndMergeDeleteSet` does; the input is not changed.
 * @param ranges - The ranges as the update wrote them.
 * @returns New, disjoint ranges in clock order.
 */
function sortAndMerge(ranges: readonly Range[]): Range[] {
  const sorted = ranges.map((r) => ({ clock: r.clock, len: r.len })).sort((a, b) => a.clock - b.clock);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.clock + last.len >= r.clock) {
      last.len = Math.max(last.len, r.clock + r.len - last.clock);
    } else {
      merged.push(r);
    }
  }
  return merged;
}

/**
 * Read an update against a struct store and count the facts the size cap
 * judges it by (design 4.1). Each client's ranges are sorted and merged
 * first, so every covered struct is visited once however the ranges overlap.
 * The store is only read.
 * @param update - A V1 update.
 * @param store - The struct store of the document it would be applied to.
 * @returns The update's shape.
 * @throws {Error} When the update cannot be decoded.
 */
export function updateShape(update: Uint8Array, store: Y.Doc["store"]): UpdateShape {
  const { ds } = Y.decodeUpdate(update);
  let splitEndpoints = 0;
  let beyondClockRanges = 0;
  let wholeTypesOnly = true;
  let coversLive = false;

  const mergedByClient = new Map<number, Range[]>();
  ds.clients.forEach((ranges, client) => {
    const state = Y.getState(store, client);
    for (const range of ranges) if (range.clock + range.len > state) beyondClockRanges += 1;
    mergedByClient.set(client, sortAndMerge(ranges));
  });

  /**
   * Whether this update deletes the given item whole.
   * @param item - A type item.
   * @returns True when one merged delete range covers it.
   */
  const deletedWhole = (item: Y.Item): boolean => {
    const ranges = mergedByClient.get(item.id.client) ?? [];
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = ranges[mid];
      if (r === undefined) break;
      if (r.clock > item.id.clock) hi = mid - 1;
      else if (r.clock + r.len <= item.id.clock) lo = mid + 1;
      else return item.id.clock + item.length <= r.clock + r.len;
    }
    return false;
  };

  // Per type: whether its own item or an ancestor's is deleted whole. Each
  // type is judged once, so deep nesting costs no more than flat content.
  const underDeleted = new Map<Y.AbstractType<unknown>, boolean>();

  /**
   * Whether this update deletes a type's item, or an ancestor type's, whole.
   * @param parent - An item's parent.
   * @returns True when the item sits under a type deleted whole.
   */
  const underDeletedType = (parent: Y.Item["parent"]): boolean => {
    const path: Y.AbstractType<unknown>[] = [];
    let verdict = false;
    for (let type = parent; type instanceof Y.AbstractType; ) {
      const known = underDeleted.get(type);
      if (known !== undefined) {
        verdict = known;
        break;
      }
      path.push(type);
      const item = type._item;
      if (item === null) break;
      if (deletedWhole(item)) {
        verdict = true;
        break;
      }
      type = item.parent;
    }
    for (const type of path) underDeleted.set(type, verdict);
    return verdict;
  };

  mergedByClient.forEach((ranges, client) => {
    const structs = store.clients.get(client) ?? [];
    const state = Y.getState(store, client);
    for (const range of ranges) {
      if (range.clock >= state) continue;
      const end = range.clock + range.len;
      let i = Y.findIndexSS(structs, range.clock);
      const head = structs[i];
      if (head !== undefined && !head.deleted && head.id.clock < range.clock) splitEndpoints += 1;
      for (; i < structs.length; i++) {
        const struct = structs[i];
        if (struct === undefined || struct.id.clock >= end) break;
        if (struct.deleted || !(struct instanceof Y.Item)) continue;
        coversLive = true;
        if (end < struct.id.clock + struct.length) splitEndpoints += 1;
        const whole = struct.id.clock >= range.clock && struct.id.clock + struct.length <= end;
        const removable = (whole && (struct.content instanceof Y.ContentType || struct.parentSub !== null)) || underDeletedType(struct.parent);
        if (!removable) wholeTypesOnly = false;
      }
    }
  });

  return { pureDelete: startsWithZero(update), splitEndpoints, beyondClockRanges, wholeTypesOnly, coversLive };
}
