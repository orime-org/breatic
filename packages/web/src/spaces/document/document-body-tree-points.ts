// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { BodyTreeView } from '@breatic/shared';

/** A selected inline subtree's current owner and zero-width native-unit boundaries. */
export interface BodyTreePoint {
  readonly owner: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Indexes every selected inline subtree in the same order as its visible native units.
 * @param view - The complete current records projection.
 * @returns Owner-relative boundaries, including independently placed C and R nodes.
 * @throws {never}
 */
export function bodyTreePoints(view: BodyTreeView): ReadonlyMap<string, BodyTreePoint> {
  const result = new Map<string, BodyTreePoint>();
  for (const owner of view.owners) {
    let cursor = 0;
    const tasks = [{ id: owner.facet, exit: false }];
    while (tasks.length > 0) {
      const { id, exit } = tasks.pop()!;
      if (exit) {
        result.set(id, { owner: owner.id, from: result.get(id)!.from, to: cursor });
        continue;
      }
      result.set(id, { owner: owner.id, from: cursor, to: cursor });
      cursor += view.pieces.get(id)?.units.length ?? 0;
      tasks.push({ id, exit: true });
      const children = view.tree.children.get(id) ?? [];
      for (let child = children.length - 1; child >= 0; child -= 1) tasks.push({ id: children[child], exit: false });
    }
  }
  return result;
}
