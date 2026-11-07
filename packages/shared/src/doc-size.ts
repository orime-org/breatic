// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as Y from "yjs";
import { z } from "zod";

/**
 * The bytes counted for one split endpoint or one delete range past the
 * server's clock of its client: either can add up to two ids (a client id
 * takes up to 5 varuint bytes, a clock up to 8), an info byte and a length
 * field to the encoded document. Collab charges an update with it and both
 * ends judge an update with {@link updateShape}, so they read this one value.
 */
export const DOC_SIZE_EVENT_BYTES = 32;

const bytes = z.number().int().nonnegative();

/**
 * The size of one Space document as collab counts it, pushed over the
 * document's stateless channel. `limit` 0 means the deployment sets no
 * limit; `bytes ≥ ceiling` means the document is past its hard ceiling.
 */
export const DocSizeStatusSchema = z.object({
  type: z.literal("doc:size"),
  bytes,
  limit: bytes,
  ceiling: bytes,
  phase: z.enum(["normal", "warning", "full"]),
});

/** One parsed `doc:size` push. */
export type DocSizeStatus = z.infer<typeof DocSizeStatusSchema>;

/** What an update holds, read against a document's struct store. */
export interface UpdateShape {
  /** The update carries no struct group: it only deletes. */
  pureDelete: boolean;
  /** The update's length less its delete set; 0 for a pure delete. */
  structBytes: number;
  /** Delete range ends falling inside a live item, which splits it. */
  splitEndpoints: number;
  /** Delete ranges ending past the store's clock of their client (they pend). */
  beyondClockRanges: number;
  /**
   * Every live item the deletes cover is covered whole and is a Y type, a
   * Map entry, or sits under a type item this update deletes whole. True
   * when the deletes cover no live item.
   */
  wholeTypesOnly: boolean;
}

/**
 * The encoded length of a varuint.
 * @param n - A non-negative integer.
 * @returns Bytes.
 */
function varUintLength(n: number): number {
  let length = 1;
  for (let v = n; v > 0x7f; v = Math.floor(v / 128)) length += 1;
  return length;
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
 * Read an update against a struct store and count the facts the size cap
 * judges it by (design 4.1). The store is only read.
 * @param update - A V1 update.
 * @param store - The struct store of the document it would be applied to.
 * @returns The update's shape.
 * @throws {Error} When the update cannot be decoded.
 */
export function updateShape(update: Uint8Array, store: Y.Doc["store"]): UpdateShape {
  const { ds } = Y.decodeUpdate(update);
  const pureDelete = startsWithZero(update);
  let dsLength = varUintLength(ds.clients.size);
  let splitEndpoints = 0;
  let beyondClockRanges = 0;
  let wholeTypesOnly = true;

  /**
   * Whether this update deletes the given item whole.
   * @param item - A type item.
   * @returns True when one delete range covers it.
   */
  const deletedWhole = (item: Y.Item): boolean =>
    (ds.clients.get(item.id.client) ?? []).some((r) => r.clock <= item.id.clock && item.id.clock + item.length <= r.clock + r.len);

  ds.clients.forEach((ranges, client) => {
    dsLength += varUintLength(client) + varUintLength(ranges.length);
    const structs = store.clients.get(client) ?? [];
    const state = Y.getState(store, client);
    for (const range of ranges) {
      dsLength += varUintLength(range.clock) + varUintLength(range.len);
      const end = range.clock + range.len;
      if (end > state) beyondClockRanges += 1;
      if (range.clock >= state) continue;
      let i = Y.findIndexSS(structs, range.clock);
      const head = structs[i];
      if (head !== undefined && !head.deleted && head.id.clock < range.clock) splitEndpoints += 1;
      for (; i < structs.length; i++) {
        const struct = structs[i];
        if (struct === undefined || struct.id.clock >= end) break;
        if (struct.deleted || !(struct instanceof Y.Item)) continue;
        if (end < struct.id.clock + struct.length) splitEndpoints += 1;
        const whole = struct.id.clock >= range.clock && struct.id.clock + struct.length <= end;
        let removable = whole && (struct.content instanceof Y.ContentType || struct.parentSub !== null);
        for (let parent = typeItemOf(struct.parent); parent !== null && !removable; parent = typeItemOf(parent.parent)) {
          if (deletedWhole(parent)) removable = true;
        }
        if (!removable) wholeTypesOnly = false;
      }
    }
  });

  return {
    pureDelete,
    structBytes: pureDelete ? 0 : update.byteLength - dsLength,
    splitEndpoints,
    beyondClockRanges,
    wholeTypesOnly,
  };
}

/**
 * The item a parent type is stored in, or null for a root type.
 * @param parent - An item's parent.
 * @returns The type's own item.
 */
function typeItemOf(parent: Y.Item["parent"]): Y.Item | null {
  return parent instanceof Y.AbstractType ? parent._item : null;
}
