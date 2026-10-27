// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a generation template becomes nodes, shared by the generate panel and
 * the agent (inner#1345): the template's structure, one node's defaults, which
 * nodes on a graph belong to one applied instance, the guide text node, and
 * the panel's own expansion.
 */

import type { GenerationTemplate, TemplateNodeKey } from "@shared/canvas/generation-templates.js";
import type { CanvasProposal, ProposalNode, ProposalNodeType } from "@shared/types/canvas-proposal.js";
import type { GenerationNodeType } from "@shared/types/model-catalog.js";

/** The key the guide text node carries; no template node may use it. */
export const TEMPLATE_GUIDE_KEY = "guide";

/** A template's structure, by key. */
export interface TemplateSkeleton {
  id: string;
  anchor: TemplateNodeKey;
  nodes: ReadonlyMap<TemplateNodeKey, { role: "generate" | "source"; type: GenerationNodeType; resource?: string }>;
  edges: readonly { from: TemplateNodeKey; to: TemplateNodeKey; into?: string }[];
  inputs: readonly { key: string; type: GenerationNodeType; feeds: readonly TemplateNodeKey[] }[];
  steps: readonly string[];
}

/** One node of the graph a match reads. */
export interface TemplateGraphNode {
  id: string;
  type: ProposalNodeType;
  /** Set on a non-anchor template node: which template and key it stands for. */
  tag?: { template: string; key: TemplateNodeKey };
  /** Set on a node the agent sent for one of a template's inputs. */
  inputTag?: { template: string; input: string };
  /** Whether the node keeps the template's mode and model; the caller decides. */
  keeps: boolean;
}

/** The graph a match reads: nodes by id, and each node's incoming edges in order. */
export interface TemplateGraph {
  nodes: ReadonlyMap<string, TemplateGraphNode>;
  incoming: ReadonlyMap<string, readonly { from: string; into?: string }[]>;
}

/** What one key matched. `unreached`: a node that left the template's settings stands in the way. */
export type TemplateKeyMatch =
  | { kind: "one"; node: string }
  | { kind: "missing" }
  | { kind: "many"; nodes: readonly string[] }
  | { kind: "unreached" };

/** What `matchTemplateInstance` found for one anchor. */
export interface TemplateInstanceMatch {
  /** Every non-anchor key. */
  keys: ReadonlyMap<TemplateNodeKey, TemplateKeyMatch>;
  /** The template edges the walk crossed. */
  walked: readonly { from: TemplateNodeKey; to: TemplateNodeKey; into?: string }[];
  /** Input key to fed key to the node assigned there. */
  inputs: ReadonlyMap<string, ReadonlyMap<TemplateNodeKey, string>>;
  /** Inputs left without a node on a matched fed node. */
  unassigned: readonly { input: string; fed: TemplateNodeKey }[];
  /** For each missing key: nodes tagged with it, of its type, claimed by no instance. */
  candidates: ReadonlyMap<TemplateNodeKey, readonly string[]>;
}

/** What the panel hands `expandTemplate`. */
export interface TemplateExpansionInput {
  /** The anchor's index in the proposal. */
  anchorAt: number;
  /** The first index appended nodes take. */
  base: number;
  /** Input key to fed key to the index of the caller's node already given there. */
  inputs: ReadonlyMap<string, ReadonlyMap<TemplateNodeKey, number>>;
  /** Edges the caller already has, by index. */
  wired: readonly { fromIndex: number; toIndex: number }[];
  /** Template keys the caller reuses, to their index. */
  reuse: ReadonlyMap<TemplateNodeKey, number>;
  /** Whether to append the guide text node. */
  guide: boolean;
}

/** The panel's expansion: nodes rewritten at the caller's indices, nodes appended from `base`, new edges. */
export interface TemplateExpansionResult {
  rewritten: ReadonlyMap<number, ProposalNode>;
  appended: readonly ProposalNode[];
  edges: CanvasProposal["edges"];
}

/**
 * A template's structure, by key.
 * @param template - The template.
 * @returns Its skeleton.
 * @throws {Error} Not implemented yet.
 */
export function templateSkeleton(template: GenerationTemplate): TemplateSkeleton {
  throw new Error(`not implemented: ${template.id}`);
}

/**
 * One node with the template's defaults filled in.
 * @param template - The template.
 * @param key - The node's key; undefined for the anchor.
 * @param sent - The node as sent.
 * @returns The node with mode, model, params and resource filled.
 * @throws {Error} Not implemented yet.
 */
export function templateNodeDefaults(template: GenerationTemplate, key: TemplateNodeKey | undefined, sent: ProposalNode): ProposalNode {
  throw new Error(`not implemented: ${template.id} ${String(key)} ${sent.name}`);
}

/**
 * Which nodes on a graph belong to the instance applied at one anchor.
 * @param skeleton - The template's structure.
 * @param graph - The graph.
 * @param anchor - The anchor's node id.
 * @returns The match.
 * @throws {Error} Not implemented yet.
 */
export function matchTemplateInstance(skeleton: TemplateSkeleton, graph: TemplateGraph, anchor: string): TemplateInstanceMatch {
  throw new Error(`not implemented: ${skeleton.id} ${String(graph.nodes.size)} ${anchor}`);
}

/**
 * The guide text node for a template with steps.
 * @param template - The template.
 * @param anchorIndex - The anchor's index in the proposal.
 * @returns The node, or undefined for a template without steps.
 * @throws {Error} Not implemented yet.
 */
export function templateGuideNode(template: GenerationTemplate, anchorIndex: number): ProposalNode | undefined {
  throw new Error(`not implemented: ${template.id} ${String(anchorIndex)}`);
}

/**
 * The panel's expansion of a template around an anchor.
 * @param template - The template.
 * @param input - What the caller already has.
 * @returns The expansion.
 * @throws {Error} Not implemented yet.
 */
export function expandTemplate(template: GenerationTemplate, input: TemplateExpansionInput): TemplateExpansionResult {
  throw new Error(`not implemented: ${template.id} ${String(input.base)}`);
}
