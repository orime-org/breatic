// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';

/** A native item's current replacement and the unit's offset within that item. */
export interface BodyNativeItem {
  readonly item: Y.Item;
  readonly offset: number;
}

/**
 * Follows the installed Yjs redone chain without conflating a deleted item with its gap.
 * @param doc - The document being inspected.
 * @param id - The stable record or native identity.
 * @returns The current native replacement, or null if it is absent.
 * @throws {never}
 */
export function bodyNativeItem(doc: Y.Doc, id: Y.ID): BodyNativeItem | null {
  let current = id;
  const seen = new Set<string>();
  for (;;) {
    const key = `${current.client}:${current.clock}`;
    if (seen.has(key) || Y.getState(doc.store, current.client) <= current.clock) return null;
    seen.add(key);
    const item = Y.getItem(doc.store, current);
    if (!(item instanceof Y.Item)) return null;
    const offset = current.clock - item.id.clock;
    if (item.redone === null) return { item, offset };
    current = Y.createID(item.redone.client, item.redone.clock + offset);
  }
}

/**
 * Reads a stored source/native token independently of the position's association.
 * @param source - The permanent source identifier.
 * @param token - The stored original native unit token.
 * @returns The original native identity, or null for an invalid token.
 * @throws {never}
 */
export function bodyTokenId(source: string, token: string | null): Y.ID | null {
  if (token === null || !token.startsWith(`${source}/`)) return null;
  const match = /^(\d+):(\d+)$/u.exec(token.slice(source.length + 1));
  if (match === null) return null;
  const client = Number(match[1]);
  const clock = Number(match[2]);
  return Number.isSafeInteger(client) && Number.isSafeInteger(clock) ? Y.createID(client, clock) : null;
}

/**
 * Tests actual native visibility, including a replaced item's containing type.
 * @param native - The current native item and unit offset.
 * @returns Whether this native unit is currently alive.
 * @throws {never}
 */
export function bodyNativeItemAlive(native: BodyNativeItem): boolean {
  if (native.item.deleted || !native.item.countable) return false;
  const parent = native.item.parent;
  return parent instanceof Y.AbstractType && (parent._item === null || !parent._item.deleted);
}
