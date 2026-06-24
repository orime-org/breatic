// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Parent-before-child ordering for Group containment.
 *
 * ReactFlow has one hard requirement when rendering parented nodes: a node
 * must appear in the array BEFORE any of its children. The canvas reads nodes
 * from Yjs in insertion order (no ordering guarantee vs. the parent), so it
 * runs {@link topoSortByParent} just before handing nodes to ReactFlow.
 *
 * Group nesting is forbidden (a Group is never a member of another Group), so
 * the real depth is always 1 (Group → member); the sort still guards against
 * cycles and dangling parents defensively.
 */

/** Minimal node shape needed to order parents before children. */
export interface TopoNode {
  id: string;
  /** Containing Group id, when this node is a member. */
  parentId?: string;
}

/**
 * Returns the nodes reordered so every parent appears before its children,
 * preserving the input order otherwise (stable). Nodes whose `parentId` is
 * absent from the set are treated as roots; cycles are broken defensively so
 * the function always terminates and returns every input node exactly once.
 * @param nodes - The nodes to order (each with an id and optional parentId).
 * @returns A new array with parents ordered before their children.
 */
export function topoSortByParent<T extends TopoNode>(nodes: ReadonlyArray<T>): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();
  const onStack = new Set<string>();
  const result: T[] = [];

  /**
   * Emit `node` after its parent (depth-first), guarding against cycles.
   * Pushes into the outer `result`.
   * @param node - The node to emit.
   */
  function visit(node: T): void {
    if (emitted.has(node.id) || onStack.has(node.id)) return;
    onStack.add(node.id);
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined;
    if (parent !== undefined) visit(parent);
    onStack.delete(node.id);
    if (emitted.has(node.id)) return;
    emitted.add(node.id);
    result.push(node);
  }

  for (const node of nodes) visit(node);
  return result;
}
