// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Applying a generation template to a node (inner#977, inner#1345), for the
 * generate panel and for an external agent (#1488 §8): what the canvas
 * already has of the template is found by the same match the agent's
 * proposals are checked with, and the rest becomes a proposal placed around
 * it by `placeProposalInDoc`.
 */

import type { GenerationTemplate, TemplateNodeKey } from '@shared/canvas/generation-templates.js';
import { expandTemplate, matchTemplateInstance, templateSkeleton, type TemplateGraphNode } from '@shared/canvas/template-expansion.js';
import type { CanvasNodeView } from '@shared/canvas/model/canvas-read.js';
import { deriveReferences } from '@shared/canvas/model/derive-references.js';
import { evaluateNodeGate } from '@shared/canvas/model/node-gate.js';
import { asContentView, type CanvasEdge } from '@shared/canvas/model/node-view.js';
import type { ExistingNode } from '@shared/canvas/model/proposal-place.js';
import type { ProposalMention } from '@shared/canvas/model/proposal-prompt.js';
import { slotForParam } from '@shared/canvas/model/slot-fill.js';
import { readSlotPick } from '@shared/canvas/model/slots.js';
import { templateParams, templateServed } from '@shared/canvas/model/template-writes.js';
import { t } from '@shared/i18n/index.js';
import type { CanvasNodeFields } from '@shared/types/canvas-node.js';
import { proposalMarkSegments, TEMPLATE_GUIDE_KEY, type CanvasProposal, type ProposalNode } from '@shared/types/canvas-proposal.js';
import type { ModelEntry } from '@shared/types/model-catalog.js';

/** Why a template is not applied. */
export type TemplateApplyRefusal =
  /** A model the template uses is not served. */
  | { reason: 'model_unavailable' }
  /** The node is not on the canvas, or is not a node a template applies to. */
  | { reason: 'not_found' }
  /** The node, or a node of the instance it would rewrite, is locked. */
  | { reason: 'locked'; nodeId: string }
  /** New nodes would join a locked group. */
  | { reason: 'group_locked' };

/** A template applied, ready to place. */
export interface TemplateApplyPlan {
  proposal: CanvasProposal;
  existing: Map<number, ExistingNode>;
  order: number[];
  /** Whether the user is left an empty node to fill or words in braces to write. */
  toFill: boolean;
}

/**
 * The template tag a node carries.
 * @param view - The node.
 * @returns Its tag.
 */
function templateTagOf(view: CanvasNodeView | undefined): NonNullable<CanvasNodeFields['data']['templateNode']> | undefined {
  return view === undefined || view.type === 'group' || view.type === 'annotation' ? undefined : view.data.templateNode;
}

/**
 * Which canvas node each generate node holds in a template input's slot, the
 * slot read under the mode of the template node the input feeds: the node
 * whose content is the slot's file, one tagged for that input of this
 * template first (design 8.6), so a take filled with a clip another take was
 * placed with finds that clip on a re-apply.
 * @param template - The template applied.
 * @param nodes - Every node on the canvas.
 * @returns Per generate node, slot param to the node holding its file.
 */
function slotFills(template: GenerationTemplate, nodes: readonly CanvasNodeView[]): Map<string, Map<string, string>> {
  const fills = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    const data = node.data as unknown as Record<string, unknown>;
    for (const input of template.inputs) {
      const fed = template.nodes.find((one) => one.key === (input.feeds?.[0] ?? template.anchor));
      if (fed?.role !== 'generate' || fed.type !== node.type) continue;
      const spec = input.into === undefined ? undefined : slotForParam(node.type, fed.mode, input.into);
      const url = spec === undefined || spec.multiple ? undefined : readSlotPick(spec, data[spec.field])?.url;
      if (url === undefined || input.into === undefined) continue;
      const holders = nodes.filter((other) => other.id !== node.id && other.type === input.type && (other.data as { content?: unknown }).content === url);
      const tagged = holders.find((other) => {
        const tag = templateTagOf(other);
        return tag?.input === true && tag.template === template.id && tag.key === input.key;
      });
      const holder = tagged ?? holders[0];
      if (holder !== undefined) fills.set(node.id, (fills.get(node.id) ?? new Map<string, string>()).set(input.into, holder.id));
    }
  }
  return fills;
}

/**
 * The material a node holds, as a proposal carries it.
 * @param view - The node.
 * @returns Its content and media numbers, or nothing when it holds none.
 */
function materialOf(view: CanvasNodeView): Pick<ProposalNode, 'material' | 'materialMedia'> {
  const data = view.data as {
    content?: unknown;
    coverUrl?: string;
    mediaWidth?: number;
    mediaHeight?: number;
    duration?: number;
    mimeType?: string;
    size?: number;
  };
  if (typeof data.content !== 'string' || data.content.length === 0) return {};
  return {
    material: data.content,
    materialMedia: {
      coverUrl: data.coverUrl ?? null,
      width: data.mediaWidth ?? null,
      height: data.mediaHeight ?? null,
      duration: data.duration ?? null,
      mimeType: data.mimeType ?? null,
      size: data.size ?? null,
    },
  };
}

/**
 * A node's name.
 * @param view - The node.
 * @returns Its name, empty when it has none.
 */
function nameOf(view: CanvasNodeView): string {
  return (view.data as { name?: string }).name ?? '';
}

/**
 * How a ref to a node already on the canvas is written: as a reference row names it.
 * @param id - The node.
 * @param view - Its view.
 * @param rails - Every node's reference rows.
 * @returns The mention.
 */
function mentionOf(id: string, view: CanvasNodeView, rails: ReadonlyMap<string, ReturnType<typeof deriveReferences>>): ProposalMention {
  for (const rows of rails.values()) {
    const row = rows.find((one) => one.sourceNodeId === id);
    if (row) {
      return {
        sourceNodeId: id,
        label: row.sourceNodeName,
        kind: row.sourceNodeType,
        ...(row.thumbnail === undefined ? {} : { thumbnail: row.thumbnail }),
      };
    }
  }
  return { sourceNodeId: id, label: nameOf(view), kind: view.type };
}

/**
 * Whether a node holds nothing yet and nothing is fetching or generating into it.
 * @param view - The node.
 * @returns Whether it stands empty.
 */
export function standsEmpty(view: CanvasNodeView | undefined): boolean {
  if (!view || view.type === 'group' || view.type === 'annotation') return false;
  return (view.data as { content?: unknown }).content === undefined && (view.data.taskCounts?.running ?? 0) === 0;
}

/**
 * Plan applying a template to a node: every template node and input the
 * canvas does not have yet is added, wired and @'d, and the template's mode,
 * model, params and prompts are written over the node and every generation it
 * reuses.
 * @param template - The template.
 * @param graph - The canvas as it is now.
 * @param graph.nodes - Every node.
 * @param graph.edges - Every edge.
 * @param nodeId - The node it is applied to, the template's anchor.
 * @param models - Every model this deployment serves, across node types.
 * @returns The plan, or why it is not applied.
 */
export function planTemplateApply(
  template: GenerationTemplate,
  graph: { nodes: readonly CanvasNodeView[]; edges: readonly CanvasEdge[] },
  nodeId: string,
  models: readonly ModelEntry[],
): TemplateApplyPlan | TemplateApplyRefusal {
  const byName = new Map(models.map((m) => [m.name, m]));
  if (!templateServed(template, new Set(byName.keys()))) return { reason: 'model_unavailable' };
  const views = new Map(graph.nodes.map((n) => [n.id, n]));
  const own = views.get(nodeId);
  if (!own || own.type === 'group' || own.type === 'annotation') return { reason: 'not_found' };
  if (evaluateNodeGate({ locked: own.data.locked === true }) !== null) return { reason: 'locked', nodeId };

  const rails = new Map(graph.nodes.map((n) => [n.id, deriveReferences(n.id, graph.nodes, graph.edges, new Map())]));
  const nodes = new Map<string, TemplateGraphNode>(
    graph.nodes.map((n): [string, TemplateGraphNode] => {
      const tag = templateTagOf(n);
      // The anchor id a tag records finds a standalone node or an input
      // the agent placed with fills again (inner#1825 §4.1, §4.2).
      const anchor = tag?.anchor === undefined ? {} : { anchor: tag.anchor };
      const marks = tag === undefined || tag.key === TEMPLATE_GUIDE_KEY
        ? {}
        : tag.input
          ? { inputTag: { template: tag.template, input: tag.key, ...anchor } }
          : { tag: { template: tag.template, key: tag.key, ...anchor } };
      // Every node keeps the template's settings here: applying writes
      // each one it reuses back to them (inner#1345 6.5 step 3).
      return [n.id, { id: n.id, type: n.type as TemplateGraphNode['type'], ...marks, keeps: true }];
    }),
  );
  const incoming = new Map([...rails].map(([id, rows]) => [id, rows.map((row) => ({ from: row.sourceNodeId }))]));
  const skeleton = templateSkeleton(template);
  const match = matchTemplateInstance(skeleton, { nodes, incoming, fills: slotFills(template, graph.nodes) }, nodeId);

  // The nodes the proposal starts from, at indices from 0: the node, then
  // each template node the board already has, then each node already given
  // for an input.
  const held: string[] = [nodeId];
  /**
   * The index a node already on the canvas takes, given it the first time it is asked for.
   * @param id - The node.
   * @returns Its index.
   */
  const indexOf = (id: string): number => {
    const at = held.indexOf(id);
    if (at >= 0) return at;
    held.push(id);
    return held.length - 1;
  };
  const reuse = new Map<TemplateNodeKey, number>();
  for (const [key, found] of match.keys) {
    const id = found.kind === 'one' ? found.node : found.kind === 'many' ? found.nodes[0] : undefined;
    if (id === undefined) continue;
    if (views.get(id)?.data.locked === true) return { reason: 'locked', nodeId: id };
    reuse.set(key, indexOf(id));
  }
  const inputs = new Map([...match.inputs].map(([key, fed]) => [key, new Map([...fed].map(([at, id]) => [at, indexOf(id)]))]));
  const wired = graph.edges.flatMap((edge) => {
    const fromIndex = held.indexOf(edge.source);
    const toIndex = held.indexOf(edge.target);
    return fromIndex >= 0 && toIndex >= 0 ? [{ fromIndex, toIndex }] : [];
  });
  const guided = graph.nodes.some((n) => {
    const tag = n.type === 'text' ? n.data.templateNode : undefined;
    return tag?.template === template.id && tag.key === TEMPLATE_GUIDE_KEY && tag.anchor === nodeId;
  });
  // A node given for an input that holds nothing yet still gets the note
  // saying what to put there, as a node placed new does.
  const emptyNodes = new Set(held.flatMap((id, index) => (index > 0 && standsEmpty(views.get(id)) ? [index] : [])));
  const expansion = expandTemplate(template, { anchorAt: 0, base: held.length, inputs, wired, reuse, guide: !guided, emptyNodes });

  const group = own.parentId === undefined ? undefined : views.get(own.parentId);
  if (expansion.appended.length > 0 && group?.type === 'group' && group.data.locked === true) return { reason: 'group_locked' };

  // The template's own nodes found on the canvas, and the input nodes this
  // instance placed, so the new ones can join their group.
  const ownInputs = [...match.inputs.values()].flatMap((fed) => [...fed.values()]).filter((id) => {
    const tag = templateTagOf(views.get(id));
    return tag?.input === true && tag.template === template.id && tag.anchor === nodeId;
  });
  const instance = new Set([...reuse.values(), ...ownInputs.map((id) => held.indexOf(id))]);
  const existing = new Map<number, ExistingNode>();
  const proposalNodes: ProposalNode[] = held.map((id, index) => {
    const view = views.get(id)!;
    const rewritten = expansion.rewritten.get(index);
    const fromTemplate = template.nodes.find((node) => node.role === 'generate' && reuse.get(node.key) === index)
      ?? (index === 0 ? template.nodes.find((node) => node.key === template.anchor) : undefined);
    const picked = fromTemplate?.role === 'generate' ? byName.get(fromTemplate.model) : undefined;
    const paramsByModel = fromTemplate?.role === 'generate' && picked ? templateParams(fromTemplate, asContentView(view.data), picked) : undefined;
    existing.set(index, {
      nodeId: id,
      mention: mentionOf(id, view, rails),
      ...(paramsByModel === undefined ? {} : { paramsByModel }),
      ...(instance.has(index) ? { instance: true } : {}),
    });
    // A node holding material carries it, so a fill naming it writes it
    // into its slot as a placed proposal's material does (inner#1825 §4.1).
    return rewritten ?? { role: 'source', type: view.type as ProposalNode['type'], name: nameOf(view), ...materialOf(view) };
  });
  const proposal: CanvasProposal = {
    nodes: [...proposalNodes, ...expansion.appended],
    edges: expansion.edges,
    rationale: '',
    // The group two or more new nodes may form is named after the template.
    groupName: t(`canvas.template.${template.id}.name`),
  };
  // Each column stacks in the template's own order, the anchor and its nodes
  // first, then its inputs, the guide last, so a node put back takes the cell
  // the first apply gave it.
  const nodeRank = new Map([template.anchor, ...template.nodes.map((node) => node.key).filter((key) => key !== template.anchor)].map((key, rank) => [key, rank]));
  const inputRank = new Map(template.inputs.map((input, rank) => [input.key, nodeRank.size + rank]));
  const last = nodeRank.size + inputRank.size;
  const heldRank = new Map<number, number>([[0, 0]]);
  for (const [key, index] of reuse) heldRank.set(index, nodeRank.get(key) ?? last);
  for (const [key, fed] of inputs) for (const index of fed.values()) heldRank.set(index, inputRank.get(key) ?? last);
  const order = proposal.nodes.map((node, index) => {
    const rank = heldRank.get(index);
    if (rank !== undefined) return rank;
    const tag = node.templateNode;
    if (tag === undefined || tag.key === TEMPLATE_GUIDE_KEY) return last + index;
    return (tag.input ? inputRank.get(tag.key) : nodeRank.get(tag.key)) ?? last + index;
  });
  const toFill =
    expansion.appended.some((node) => node.role === 'source' && node.resource === undefined) ||
    proposal.nodes.some((node) => proposalMarkSegments(node).some((segment) => segment.slot?.kind === 'tweak'));
  return { proposal, existing, order, toFill };
}
