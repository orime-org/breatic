// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How a generation template becomes nodes, shared by the generate panel and
 * the agent (inner#1345): the template's structure, one node's defaults, which
 * nodes on a graph belong to one applied instance, the guide text node, and
 * the panel's own expansion.
 */

import { templateAnchor, type GenerationTemplate, type TemplateNodeKey } from "@shared/canvas/generation-templates.js";
import { t } from "@shared/i18n/index.js";
import {
  markedSegments,
  type CanvasProposal,
  type PromptSegment,
  type ProposalNode,
  type ProposalNodeType,
} from "@shared/types/canvas-proposal.js";
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
 * @throws {never} Never.
 */
export function templateSkeleton(template: GenerationTemplate): TemplateSkeleton {
  return {
    id: template.id,
    anchor: template.anchor,
    nodes: new Map(
      template.nodes.map((node) => [
        node.key,
        node.role === "source" ? { role: node.role, type: node.type, resource: node.resource } : { role: node.role, type: node.type },
      ]),
    ),
    edges: template.edges.map((edge) => ({ ...edge })),
    inputs: template.inputs.map((input) => ({ key: input.key, type: input.type, feeds: input.feeds ?? [template.anchor] })),
    steps: [...template.steps],
  };
}

/**
 * One node with the template's defaults filled in. The template is a start,
 * not a lock: what was sent stays, and the template's params come along only
 * while the node keeps both the template's mode and model, the two they
 * belong to.
 * @param template - The template.
 * @param key - The node's key; undefined for the anchor.
 * @param sent - The node as sent.
 * @returns The node with mode, model, params and resource filled.
 * @throws {never} Never.
 */
export function templateNodeDefaults(template: GenerationTemplate, key: TemplateNodeKey | undefined, sent: ProposalNode): ProposalNode {
  const node = template.nodes.find((candidate) => candidate.key === (key ?? template.anchor));
  if (!node) return sent;
  if (node.role === "source") return { ...sent, resource: node.resource };
  const mode = sent.mode ?? node.mode;
  const model = sent.model ?? node.model;
  const keeps = mode === node.mode && model === node.model;
  const params = keeps ? { ...node.params, ...sent.params } : sent.params;
  return { ...sent, mode, model, ...(params === undefined ? {} : { params }) };
}

/**
 * Which nodes on a graph belong to the instance applied at one anchor.
 *
 * The walk starts at the anchor and follows only the template's own edges
 * backwards, through nodes that keep the template's settings; a node is taken
 * for a key only when it is wired in where that key is wired and carries its
 * tag, so a copy lying loose or a neighbouring instance is never mistaken for
 * this one.
 * @param skeleton - The template's structure.
 * @param graph - The graph.
 * @param anchor - The anchor's node id.
 * @returns The match.
 * @throws {never} Never.
 */
export function matchTemplateInstance(skeleton: TemplateSkeleton, graph: TemplateGraph, anchor: string): TemplateInstanceMatch {
  /**
   * A node's incoming edges, in order.
   * @param id - The node id.
   * @returns Its incoming edges.
   */
  const incoming = (id: string): readonly { from: string; into?: string }[] => graph.incoming.get(id) ?? [];
  /**
   * A key's node type in the template.
   * @param key - The key.
   * @returns Its type.
   */
  const typeOf = (key: TemplateNodeKey): ProposalNodeType | undefined => skeleton.nodes.get(key)?.type;
  /**
   * Whether a node carries this template's tag for a key, with the key's type.
   * @param id - The node id.
   * @param key - The key.
   * @returns Whether it does.
   */
  const isTagged = (id: string, key: TemplateNodeKey): boolean => {
    const node = graph.nodes.get(id);
    return node?.tag?.template === skeleton.id && node.tag.key === key && node.type === typeOf(key);
  };

  const keys = new Map<TemplateNodeKey, TemplateKeyMatch>();
  const at = new Map<TemplateNodeKey, string>([[skeleton.anchor, anchor]]);
  const walked: { from: TemplateNodeKey; to: TemplateNodeKey; into?: string }[] = [];
  /**
   * Whether the node settled for a key keeps the template's settings.
   * @param key - The key.
   * @returns Whether it does.
   */
  const keepsAt = (key: TemplateNodeKey): boolean => {
    const id = at.get(key);
    return id !== undefined && graph.nodes.get(id)?.keeps === true;
  };
  // Keys in the order the walk settles them, so a key is only looked for once
  // the node it is wired into has been settled.
  const queue: TemplateNodeKey[] = [skeleton.anchor];
  const blocked = new Map<TemplateNodeKey, "missing" | "unreached">();
  if (!keepsAt(skeleton.anchor)) blocked.set(skeleton.anchor, "unreached");
  for (let i = 0; i < queue.length; i += 1) {
    const to = queue[i] as TemplateNodeKey;
    for (const edge of skeleton.edges) {
      if (edge.to !== to || keys.has(edge.from)) continue;
      const status = blocked.get(to);
      if (status) {
        keys.set(edge.from, { kind: status });
        blocked.set(edge.from, status);
      } else {
        walked.push(edge.into === undefined ? { from: edge.from, to: edge.to } : { from: edge.from, to: edge.to, into: edge.into });
        const found = incoming(at.get(to) as string)
          .map((wire) => wire.from)
          .filter((id) => isTagged(id, edge.from));
        const first = found[0];
        if (first === undefined) {
          keys.set(edge.from, { kind: "missing" });
          blocked.set(edge.from, "missing");
        } else {
          keys.set(edge.from, found.length === 1 ? { kind: "one", node: first } : { kind: "many", nodes: found });
          at.set(edge.from, first);
          if (!keepsAt(edge.from)) blocked.set(edge.from, "unreached");
        }
      }
      queue.push(edge.from);
    }
  }
  for (const key of skeleton.nodes.keys()) {
    if (key !== skeleton.anchor && !keys.has(key)) keys.set(key, { kind: "unreached" });
  }

  // Inputs go to nodes wired into each fed node that keeps the template:
  // first a node the agent tagged for that input, then, in declaration order,
  // the first wired node of the input's type no other input has taken.
  /**
   * The fed nodes of an input that the walk settled and that keep the template.
   * @param input - The input.
   * @returns Each fed key with its node id.
   */
  const fedNodes = (input: TemplateSkeleton["inputs"][number]): Array<[TemplateNodeKey, string]> =>
    input.feeds.flatMap((fed) => (keepsAt(fed) && !blocked.has(fed) ? [[fed, at.get(fed) as string] as [TemplateNodeKey, string]] : []));
  const inputs = new Map<string, Map<TemplateNodeKey, string>>();
  const taken = new Map<string, string>();
  /**
   * Assigns a node to an input on one fed node.
   * @param input - The input key.
   * @param fed - The fed key.
   * @param id - The node id.
   */
  const give = (input: string, fed: TemplateNodeKey, id: string): void => {
    inputs.set(input, (inputs.get(input) ?? new Map<TemplateNodeKey, string>()).set(fed, id));
    taken.set(id, input);
  };
  for (const input of skeleton.inputs) {
    for (const [fed, id] of fedNodes(input)) {
      const own = incoming(id).find((wire) => {
        const node = graph.nodes.get(wire.from);
        return node?.inputTag?.template === skeleton.id && node.inputTag.input === input.key && node.type === input.type;
      });
      if (own) give(input.key, fed, own.from);
    }
  }
  for (const input of skeleton.inputs) {
    for (const [fed, id] of fedNodes(input)) {
      if (inputs.get(input.key)?.has(fed)) continue;
      const wired = incoming(id).map((wire) => wire.from);
      const shared = [...(inputs.get(input.key)?.values() ?? [])].find((node) => wired.includes(node));
      const free = wired.find((from) => {
        const node = graph.nodes.get(from);
        if (!node || node.type !== input.type || node.tag?.template === skeleton.id || taken.has(from)) return false;
        return node.inputTag?.template !== skeleton.id;
      });
      const chosen = shared ?? free;
      if (chosen !== undefined) give(input.key, fed, chosen);
    }
  }
  const unassigned = skeleton.inputs.flatMap((input) =>
    fedNodes(input).flatMap(([fed]) => (inputs.get(input.key)?.has(fed) ? [] : [{ input: input.key, fed }])),
  );

  // A node is claimed when it is wired into a place its key is wired: into a
  // node carrying the downstream key's tag, or into an untagged node of the
  // anchor's type where the anchor takes it.
  const outgoing = new Map<string, string[]>();
  for (const [to, wires] of graph.incoming) {
    for (const wire of wires) outgoing.set(wire.from, [...(outgoing.get(wire.from) ?? []), to]);
  }
  /**
   * Whether a tagged node is wired into a place its key is wired.
   * @param id - The node id.
   * @param key - The key it is tagged with.
   * @returns Whether some instance claims it.
   */
  const claimed = (id: string, key: TemplateNodeKey): boolean =>
    skeleton.edges.some(
      (edge) =>
        edge.from === key &&
        (outgoing.get(id) ?? []).some((to) => {
          const target = graph.nodes.get(to);
          if (!target) return false;
          if (edge.to !== skeleton.anchor) return target.tag?.template === skeleton.id && target.tag.key === edge.to;
          return target.tag === undefined && target.type === typeOf(skeleton.anchor);
        }),
    );
  const candidates = new Map<TemplateNodeKey, readonly string[]>();
  for (const [key, found] of keys) {
    if (found.kind !== "missing") continue;
    candidates.set(key, [...graph.nodes.keys()].filter((id) => isTagged(id, key) && !claimed(id, key)));
  }

  return { keys, walked, inputs, unassigned, candidates };
}

/**
 * The guide text node for a template with steps: the template's name, then
 * each step numbered, in the reader's language.
 * @param template - The template.
 * @param anchorIndex - The anchor's index in the proposal.
 * @returns The node, or undefined for a template without steps.
 * @throws {never} Never.
 */
export function templateGuideNode(template: GenerationTemplate, anchorIndex: number): ProposalNode | undefined {
  if (template.steps.length === 0) return undefined;
  const name = t(`canvas.template.${template.id}.name`);
  const steps = template.steps.map((step, i) => `${String(i + 1)}. ${t(`canvas.template.${template.id}.step.${step}`)}`);
  return {
    role: "written",
    type: "text",
    name,
    prompt: [{ text: [name, ...steps].join("\n") }],
    templateNode: { template: template.id, key: TEMPLATE_GUIDE_KEY, anchor: anchorIndex },
  };
}

/**
 * The panel's expansion of a template around an anchor: every template node
 * and input the caller does not already have, wired as the template wires
 * them, with each generate node's prompt from the locale and every reference
 * mark bound by name to the node it stands for.
 * @param template - The template.
 * @param input - What the caller already has.
 * @returns The expansion.
 * @throws {never} Never.
 */
export function expandTemplate(template: GenerationTemplate, input: TemplateExpansionInput): TemplateExpansionResult {
  const skeleton = templateSkeleton(template);
  /**
   * One of the template's strings in the reader's language.
   * @param rest - The key under the template's locale entry.
   * @returns The string.
   */
  const text = (rest: string): string => t(`canvas.template.${template.id}.${rest}`);
  const appended: ProposalNode[] = [];
  /**
   * Appends a node.
   * @param node - The node.
   * @returns Its index in the proposal.
   */
  const append = (node: ProposalNode): number => appended.push(node) - 1 + input.base;

  const indexOf = new Map<TemplateNodeKey, number>([[template.anchor, input.anchorAt]]);
  const pending: Array<{ index: number; key: TemplateNodeKey }> = [];
  for (const node of template.nodes) {
    if (node.key === template.anchor) continue;
    const reused = input.reuse.get(node.key);
    if (reused !== undefined) {
      indexOf.set(node.key, reused);
      if (node.role === "generate") pending.push({ index: reused, key: node.key });
      continue;
    }
    const base: ProposalNode = { role: node.role, type: node.type, name: text(`node.${node.key}.name`) };
    const index = append({ ...templateNodeDefaults(template, node.key, base), templateNode: { template: template.id, key: node.key } });
    indexOf.set(node.key, index);
    if (node.role === "generate") pending.push({ index, key: node.key });
  }

  // Each input's node on each fed node: the caller's, else the one the caller
  // gave on another fed node, else one new empty node for all of them.
  const inputAt = new Map<string, Map<TemplateNodeKey, number>>();
  const fresh = new Set<string>();
  for (const one of skeleton.inputs) {
    const given = input.inputs.get(one.key);
    const fallback = one.feeds.map((fed) => given?.get(fed)).find((index) => index !== undefined);
    const index = fallback ?? append({ role: "source", type: one.type, name: text(`input.${one.key}.name`) });
    if (fallback === undefined) fresh.add(one.key);
    inputAt.set(one.key, new Map(one.feeds.map((fed) => [fed, given?.get(fed) ?? index])));
  }

  const edges: CanvasProposal["edges"] = [];
  const seen = new Set(input.wired.map((edge) => `${String(edge.fromIndex)}>${String(edge.toIndex)}`));
  /**
   * Adds an edge the caller does not have yet.
   * @param fromIndex - Where it starts.
   * @param toIndex - Where it ends.
   * @param into - Where on the target it goes.
   */
  const wire = (fromIndex: number, toIndex: number, into: string | undefined): void => {
    const pair = `${String(fromIndex)}>${String(toIndex)}`;
    if (fromIndex === toIndex || seen.has(pair)) return;
    seen.add(pair);
    edges.push(into === undefined ? { fromIndex, toIndex } : { fromIndex, toIndex, into });
  };
  for (const edge of skeleton.edges) wire(indexOf.get(edge.from) as number, indexOf.get(edge.to) as number, edge.into);
  for (const one of skeleton.inputs) {
    for (const fed of one.feeds) wire(inputAt.get(one.key)?.get(fed) as number, indexOf.get(fed) as number, "pool");
  }

  // A mark names its target in the reader's language: an input feeding the
  // node, or a template node wired into its pool.
  /**
   * A generate node's prompt, each reference mark bound by name and the notes of its new inputs on top.
   * @param key - The node's key.
   * @returns The prompt.
   */
  const promptOf = (key: TemplateNodeKey): PromptSegment[] => {
    const targets = new Map<string, number>();
    for (const one of skeleton.inputs) {
      const index = inputAt.get(one.key)?.get(key);
      if (index !== undefined) targets.set(text(`input.${one.key}.name`), index);
    }
    for (const edge of skeleton.edges) {
      if (edge.to === key && edge.into === "pool") targets.set(text(`node.${edge.from}.name`), indexOf.get(edge.from) as number);
    }
    const notes = skeleton.inputs
      .filter((one) => fresh.has(one.key) && one.feeds.includes(key))
      .map((one): PromptSegment => ({ slot: { kind: "note", label: text(`input.${one.key}.note`) } }));
    const words = markedSegments(text(key === template.anchor ? "prompt" : `node.${key}.prompt`)).map((segment): PromptSegment => {
      const target = segment.slot?.kind === "asset" ? targets.get(segment.slot.label) : undefined;
      return target === undefined ? segment : { ref: target };
    });
    return [...notes, ...words];
  };

  const anchorNode = templateAnchor(template);
  const rewritten = new Map<number, ProposalNode>();
  const anchorBase: ProposalNode = { role: "generate", type: anchorNode.type, name: text("name") };
  rewritten.set(input.anchorAt, { ...templateNodeDefaults(template, undefined, anchorBase), prompt: promptOf(template.anchor) });
  for (const { index, key } of pending) {
    const prompt = promptOf(key);
    if (index >= input.base) {
      const at = index - input.base;
      appended[at] = { ...(appended[at] as ProposalNode), prompt };
    } else {
      const type = skeleton.nodes.get(key)?.type ?? anchorNode.type;
      const base: ProposalNode = { role: "generate", type, name: text(`node.${key}.name`) };
      rewritten.set(index, { ...templateNodeDefaults(template, key, base), prompt });
    }
  }

  if (input.guide) {
    const guide = templateGuideNode(template, input.anchorAt);
    if (guide) append(guide);
  }
  return { rewritten, appended, edges };
}
