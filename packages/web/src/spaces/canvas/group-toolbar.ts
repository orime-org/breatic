// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pure decision logic for the canvas selection floating toolbar (the
 * `NodeToolbar` shown above a marquee selection). Given the current selection
 * and the membership shape of all nodes, it decides what the toolbar offers:
 * group a fresh selection, ungroup a selected group, or nothing.
 *
 * Kept free of React / ReactFlow so the rule is unit-tested in isolation; the
 * toolbar component maps its `CanvasNodeView`s to {@link NodeGroupInfo} and
 * renders the returned offer.
 */

/** Minimal per-node info the toolbar rule needs (a group + its members). */
export interface NodeGroupInfo {
  id: string;
  /** Whether this node is a `type='group'` container. */
  isGroup: boolean;
  /** The group's member ids (only meaningful when `isGroup`). */
  childIds?: string[];
  /** Whether the group is locked — a locked group cannot be ungrouped. */
  locked?: boolean;
}

/** What the floating toolbar offers for the current selection. */
export type GroupToolbar =
  | { kind: 'group' }
  | { kind: 'ungroup'; groupId: string }
  | { kind: 'none' };

/**
 * Decide the floating-toolbar offer for a selection.
 *
 * - Exactly one selected node that is a group → **ungroup** (with its id).
 * - Two or more selected nodes that are ALL loose content (not a group, not
 *   already a member of any group) → **group**. The all-loose guard keeps the
 *   no-nesting + only-loose-nodes invariants: a group node or an already-grouped node in
 *   the selection makes grouping unavailable.
 * - Anything else → **none**.
 * @param selectedIds - Ids of the currently selected nodes.
 * @param nodes - Group-membership info for every node on the canvas.
 * @returns The toolbar offer for this selection.
 */
export function computeGroupToolbar(
  selectedIds: ReadonlyArray<string>,
  nodes: ReadonlyArray<NodeGroupInfo>,
): GroupToolbar {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (selectedIds.length === 1) {
    const only = byId.get(selectedIds[0]);
    // A locked group's structure is frozen — no ungroup offer.
    if (only?.isGroup && !only.locked) {
      return { kind: 'ungroup', groupId: only.id };
    }
  }

  if (selectedIds.length >= 2) {
    const memberIds = new Set<string>();
    for (const n of nodes) {
      if (n.isGroup) for (const c of n.childIds ?? []) memberIds.add(c);
    }
    const allLoose = selectedIds.every((id) => {
      const n = byId.get(id);
      return n != null && !n.isGroup && !memberIds.has(id);
    });
    if (allLoose) return { kind: 'group' };
  }

  return { kind: 'none' };
}
