// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every way the proposal check can refuse, by name, and whether its reason
 * carries a fix (design 5.10).
 *
 * A reason says what is wrong, the rule from the catalog it breaks, and the
 * facts of the proposal the agent reasons from; the agent puts it right. A fix
 * is written only where one action on the element the refusal names is the
 * only way to clear it, the node's mode and model held as they are. Each name
 * is keyed here with where its fix acts -- on a node, on the group, or none --
 * and `refuse` takes a fix built for that place exactly for the names marked
 * with one: a fix that acts on a node can only be built from the node's index
 * and name, so the same value standing rightly on another node is never in
 * its reach. A test keyed by these names holds each reason to its statements
 * and each marked fix to clearing its refusal.
 */

/** Every refusal the proposal check gives, each marked with where its one fix acts, or false for none. */
export const REFUSALS = {
  "nothing-generates": false,
  "nothing-generates-words": false,
  "edge-outside": "node",
  "edge-self-loop": "node",
  "edge-repeated": false,
  "edge-into-nothing-generating": false,
  "edge-not-allowed": "node",
  "edge-ring": false,
  "group-unnamed": "group",
  "template-unknown": false,
  "template-key-unknown": false,
  "template-key-kind": false,
  "template-resource-material": false,
  "template-key-missing": false,
  "template-key-repeated": false,
  "template-edge-missing": "node",
  "template-edge-into": "node",
  "template-input-missing": false,
  "template-no-prompt": "node",
  "sources-no-taker": false,
  "sources-over-room": false,
  "material-unused": false,
  "loose-without-note": false,
  "text-generates": false,
  "no-mode-model": false,
  "mode-unbacked": false,
  "no-model-for-kind": false,
  "model-not-in-mode": false,
  "shots-outside-multishot": "node",
  "multishot-no-shots": "node",
  "shots-with-prompt": "node",
  "no-prompt-box": "node",
  "ref-outside": "node",
  "ref-self": "node",
  "ref-arrives-otherwise": false,
  "ref-not-pooled": false,
  "ref-not-pooled-no-pool": "node",
  "way-over-room": false,
  "ref-missing": false,
  "notes-missing": "node",
  "shot-empty": false,
  "too-many-shots": false,
  "shot-too-long": false,
  "shots-duration": false,
  "prompt-missing": "node",
  "lyrics-missing": false,
  "prompt-too-long": false,
  "script-too-long-for-shot": false,
  "written-takes-no-mark": "node",
  "material-not-source": false,
  "material-not-ours": "node",
  "material-not-ours-media": false,
  "material-missing": false,
  "material-wrong-kind": false,
  "text-source": false,
  "source-configured": false,
  "written-not-text": false,
  "written-configured": false,
  "written-empty": false,
  "mark-typed": false,
  "param-undeclared": "node",
  "param-from-list": "node",
  "param-box": "node",
  "param-pool": "node",
  "param-slot": "node",
  "param-storyboard": "node",
  "param-storyboard-other-mode": "node",
  "param-no-control": "node",
  "param-gated-off": false,
  "param-option": false,
  "param-not-number": false,
  "param-out-of-range": false,
  "param-off-step": false,
  "edge-kind-not-taken": false,
  "edge-kind-not-taken-link": false,
  "edge-into-ambiguous": false,
  "edge-not-an-entry": false,
  "fill-outside": "node",
  "fill-self": "node",
  "fill-not-a-slot": "node",
  "fill-into-pool": "node",
  "fill-no-material": "node",
  "fill-wrong-kind": "node",
  "fill-repeated": "node",
  "fill-twice": false,
} as const satisfies Record<string, "node" | "group" | false>;

/** The name of one refusal. */
export type RefusalId = keyof typeof REFUSALS;

/** A refusal: its name, and what the agent reads. */
export interface Refusal {
  ok: false;
  refusal: RefusalId;
  reason: string;
}

/** Where a fix acts, carried by its type so one built for a node cannot pass for one built for the group. */
declare const ACTS_ON: unique symbol;

/** A node as a fix and an edge name it: its index and its name, or that it is not in the group. */
export type NodeLabel = string & { readonly [ACTS_ON]: "label" };

/** A fix that acts on one node, or on the edges between two. */
export type NodeFix = string & { readonly [ACTS_ON]: "node" };

/** A fix that acts on the group as a whole. */
export type GroupFix = string & { readonly [ACTS_ON]: "group" };

/** The fix a refusal's reason ends on, of the kind its name is marked with, or nothing. */
type FixFor<Id extends RefusalId> = (typeof REFUSALS)[Id] extends "node"
  ? [fix: NodeFix]
  : (typeof REFUSALS)[Id] extends "group"
    ? [fix: GroupFix]
    : [];

/**
 * A ref as the agent sends it, which is how a refusal quotes one.
 * @param index - The node it points at.
 * @returns The segment's JSON.
 * @throws {never} Never.
 */
export function refAsSent(index: number): string {
  return `{"ref": ${String(index)}}`;
}

/**
 * A node as a refusal names it where its name alone may not be unique: its
 * index, and its name or that no node sits there.
 * @param nodes - The proposal's nodes.
 * @param at - The index.
 * @returns The label.
 * @throws {never} Never.
 */
export function nodeLabel(nodes: readonly { name: string }[], at: number): NodeLabel {
  const node = nodes[at];
  return `node ${String(at)} (${node === undefined ? "not in the group" : `"${node.name}"`})` as NodeLabel;
}

/**
 * A fix that acts on one node.
 * @param at - The node.
 * @param action - What to do there, starting lower case and ending on a full stop.
 * @returns The fix.
 * @throws {never} Never.
 */
export function fixOn(at: NodeLabel, action: string): NodeFix {
  return `On ${at}, ${action}` as NodeFix;
}

/**
 * The fix that takes off every edge between two nodes.
 * @param from - The node they run from.
 * @param to - The node they run to, or the node itself.
 * @returns The fix.
 * @throws {never} Never.
 */
export function fixEdges(from: NodeLabel, to: NodeLabel | "itself"): NodeFix {
  return `Take every edge from ${from} to ${to} off.` as NodeFix;
}

/**
 * A fix that acts on the group as a whole.
 * @param action - What to do, as a sentence.
 * @returns The fix.
 * @throws {never} Never.
 */
export function fixGroup(action: string): GroupFix {
  return action as GroupFix;
}

/**
 * A refusal, named.
 * @param refusal - Its name.
 * @param reason - What is wrong, the rule it breaks and the facts of the proposal.
 * @param fix - The one fix, for a name marked with one; the reason ends on it.
 * @returns The refusal.
 * @throws {never} Never.
 */
export function refuse<Id extends RefusalId>(refusal: Id, reason: string, ...fix: FixFor<Id>): Refusal {
  return { ok: false, refusal, reason: [reason, ...fix].join(" ") };
}
