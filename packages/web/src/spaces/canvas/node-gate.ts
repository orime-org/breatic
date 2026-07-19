// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The single source of truth for canvas node-state gating: given a node's
 * mutation-relevant state (locked / handling) and the operation the user is
 * attempting, decide whether it is allowed and — when blocked — which warning
 * toast explains why.
 *
 * Two states gate mutations, with different scope:
 *   - `locked` (user-set, persistent "do not touch") freezes EVERY mutation;
 *   - `handling` (system-set while a task writes the node) freezes only the
 *     CONTENT-affecting mutations (delete / edit / upload / generate), leaving
 *     position and name free — they don't race the in-flight content write.
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
  handling: boolean;
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
  handling: 'canvas.gate.handling',
};

/**
 * The operations `handling` freezes — the content-affecting ones. Position
 * (`move`) and `rename` are orthogonal to the in-flight content write, so they
 * stay allowed while handling; only `locked` freezes them.
 */
const HANDLING_FROZEN: ReadonlySet<NodeMutation> = new Set<NodeMutation>([
  'delete',
  'editContent',
  'upload',
  'generate',
]);

/**
 * Evaluate whether an operation is allowed on a node in the given state.
 * `locked` blocks every operation; `handling` blocks only the content-affecting
 * ones. `locked` takes precedence when both hold (the harder freeze).
 * @param state - The node's locked / handling state.
 * @param op - The operation being attempted.
 * @returns A block verdict (reason + toast key), or null when the op is allowed.
 */
export function evaluateNodeGate(
  state: NodeGateState,
  op: NodeMutation,
): NodeGateBlock | null {
  if (state.locked) {
    return { reason: 'locked', toastKey: NODE_GATE_TOAST_KEY.locked };
  }
  if (state.handling && HANDLING_FROZEN.has(op)) {
    return { reason: 'handling', toastKey: NODE_GATE_TOAST_KEY.handling };
  }
  return null;
}
