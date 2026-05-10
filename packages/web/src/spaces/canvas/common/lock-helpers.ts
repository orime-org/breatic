/**
 * Lock helpers — canonical implementation of "is this node locked?"
 * shared by `NodeContextMenu`, `HotkeysHandler`, `ProjectCanvasContent`,
 * and any future surface that needs to gate destructive actions.
 *
 * The v13 schema (F1, spec §10.13.6) lets *any* node carry
 * `data.locked: boolean`, not just groups. A locked node blocks:
 *
 *   - accidental deletes (delete-key + right-click "Delete")
 *   - mini-tool / Worker writes (enforced backend-side)
 *
 * Group containment still cascades — children of a locked group are
 * locked transitively even when their own `data.locked === false`.
 *
 * Two helpers because both views are useful: `getLockedGroupIds`
 * is fast (one O(n) scan) and reusable across multiple node lookups,
 * while `isNodeLocked(node, lockedGroupIds)` is the per-node gate
 * that callers run inside their own selection / target loops.
 *
 * Pre-F9 these helpers were duplicated in `HotkeysHandler` and
 * `view/canvas-helpers.ts`; F9 promoted them here so the lock
 * predicate stays in lock-step across surfaces.
 */
import type { Node } from '@xyflow/react';

/** Annotation node type id. Locking is intentionally not surfaced for these (spec §10.13.6: "annotation 节点不允许"). */
export const NON_LOCKABLE_NODE_TYPES: ReadonlySet<string> = new Set(['annotation']);

/** Project a node's `data.locked` flag, defensively defaulting to `false` for unknown shapes. */
function readLocked(node: Node): boolean {
  const data = node.data as { locked?: boolean } | undefined;
  return data?.locked === true;
}

/** Read the ReactFlow parent id under either field name; ReactFlow v11 used `parentNode`, v12 uses `parentId`. */
function readParentId(node: Node): string | undefined {
  const n = node as Node & { parentId?: string; parentNode?: string };
  return n.parentId ?? n.parentNode;
}

/**
 * Collect ids of every node that is itself a locked group. Used
 * as a memoized cache when computing transitive lock state for
 * many descendants in one pass.
 *
 * Only group nodes can transitively lock children — locking an
 * image node doesn't lock its mini-tool siblings (those have
 * their own lock flag).
 */
export function getLockedGroupIds(nodes: Node[]): Set<string> {
  const set = new Set<string>();
  for (const n of nodes) {
    if (n.type === 'group' && readLocked(n)) {
      set.add(n.id);
    }
  }
  return set;
}

/**
 * True when the given node should be treated as locked — either
 * its own `data.locked` is true, or it's a descendant of a locked
 * group.
 *
 * Pass the result of `getLockedGroupIds(nodes)` for the second
 * arg; recomputing it per call is fine for tiny canvases but
 * wasteful when iterating many nodes in one action handler.
 */
export function isNodeLocked(node: Node, lockedGroupIds: Set<string>): boolean {
  if (readLocked(node)) return true;
  const parentId = readParentId(node);
  return parentId !== undefined && lockedGroupIds.has(parentId);
}

/**
 * Set view of locked node ids for fast membership checks. Used by
 * surfaces that need an "is this id locked?" lookup without holding
 * onto the full node list (e.g. when computing locked-edge gates
 * from edge endpoints).
 */
export function getLockedNodeIds(nodes: Node[]): Set<string> {
  const lockedGroupIds = getLockedGroupIds(nodes);
  const ids = new Set<string>();
  for (const n of nodes) {
    if (isNodeLocked(n, lockedGroupIds)) ids.add(n.id);
  }
  return ids;
}

/**
 * Whether this node type is allowed to surface a lock toggle in
 * its right-click menu. Annotations (today the only opt-out) are
 * just user-private sticky notes — nothing in the canvas semantics
 * benefits from locking them, and the menu stays cleaner without a
 * toggle that wouldn't gate any meaningful action downstream.
 */
export function isNodeLockable(node: Node | undefined): boolean {
  if (!node) return false;
  if (!node.type) return true;
  return !NON_LOCKABLE_NODE_TYPES.has(node.type);
}
