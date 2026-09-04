// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The single source of truth for canvas node-state gating: given a node's
 * lock and the operation the user is attempting, decide whether it is allowed
 * and — when blocked — which warning toast explains why.
 *
 * `locked` is the node's OWN lock (`data.locked`) and freezes EVERY mutation
 * of THIS node. A GROUP lock does NOT flow in here: it freezes only member
 * geometry (move) + structure (delete) via the group-aware set in
 * group-membership.ts, and never a member's content / name — this function is
 * only ever fed a node's own lock flag, never a group-expanded one.
 *
 * A node carries several tasks at once (#186), so a task in flight gates
 * nothing here: the only thing it still freezes is deleting the node, which
 * `group-membership.ts` decides from the node's own counts.
 *
 * The policy is pure and modality-agnostic: it keys on state + operation, never
 * on node type, so image / text / audio / video nodes all gate identically —
 * a future generatable modality inherits the gate by routing its mutating
 * entry points through this function. Enforcement points (the CanvasSpace
 * delete guard, upload activation, TextNode edit entry, the Generate panel)
 * call this and act on the verdict; see the node-state gating section in
 * web/CLAUDE.md.
 */

/**
 * A mutating operation a user can attempt on a canvas node. Connecting an edge
 * FROM (or to) a node is deliberately NOT a member: the lock gates a node's own
 * CONTENT, and an edge is an upstream/downstream RELATIONSHIP, not content — so
 * connecting from a locked node stays allowed and ungated (user ruling
 * 2026-07-18). Do not add a `connect` member or gate `onConnect`.
 */
export type NodeMutation =
  | 'move'
  | 'delete'
  | 'rename'
  | 'editContent'
  | 'upload'
  | 'generate';

/** Why a mutation is blocked. */
export type NodeGateReason = 'locked' | 'handling';

/** A node's mutation-relevant state. */
export interface NodeGateState {
  /** The user froze this node (or its group) — blocks every mutation. */
  locked: boolean;
  /** A task is writing this node — blocks content-affecting mutations. */
}

/** A blocked verdict: the reason plus the i18n key for the warning toast. */
export interface NodeGateBlock {
  reason: NodeGateReason;
  /** i18n key for the `toast.warning` an imperative enforcement point shows. */
  toastKey: string;
}

/** i18n keys for the warning toast, one per block reason. */
export const NODE_GATE_TOAST_KEY: Readonly<Record<NodeGateReason, string>> = {
  locked: 'canvas.gate.locked',
  // Deleting a node that still carries a running task, decided from the
  // node's own counts in `group-membership.ts` (#186 §7.7).
  handling: 'canvas.gate.handling',
};

/**
 * Evaluate whether an operation is allowed on a node in the given state.
 * @param state - The node's lock state.
 * @returns A block verdict (reason + toast key), or null when it is allowed.
 */
export function evaluateNodeGate(state: NodeGateState): NodeGateBlock | null {
  if (state.locked) {
    return { reason: 'locked', toastKey: NODE_GATE_TOAST_KEY.locked };
  }
  return null;
}
