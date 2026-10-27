// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  TEMPLATE_GUIDE_KEY,
  expandTemplate,
  matchTemplateInstance,
  proposalMarkSegments,
  t,
  templateSkeleton,
  type CanvasProposal,
  type GenerationTemplate,
  type ModelEntry,
  type ProposalNode,
  type TemplateGraphNode,
  type TemplateNodeKey,
} from '@breatic/shared';

import { readCanvasGraph, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { asContentView } from '@web/data/yjs/node-view';
import { toast } from '@web/lib/toast';
import { evaluateNodeGate } from '@web/spaces/canvas/node-gate';
import { warnNodeGate } from '@web/spaces/canvas/node-gate-toast';
import { deriveReferences } from '@web/spaces/canvas/generate/derive-references';
import type { ProposalMention } from '@web/spaces/canvas/generate/proposal-prompt';
import { templateServed, templateWrites } from '@web/spaces/canvas/generate/template-writes';
import type { ExistingNode } from '@web/spaces/canvas/use-node-creation';

/** Places a template's proposal around nodes already on the canvas: `CanvasSpace`'s callback. */
export type PlaceTemplate = (proposal: CanvasProposal, existing: ReadonlyMap<number, ExistingNode>) => unknown;

/**
 * Applies a picked template to a generate panel's node (inner#977,
 * inner#1345).
 *
 * The board is read fresh from Yjs at click time, and what the template already
 * has around the node is found by the same match the agent's proposals are
 * checked with (`matchTemplateInstance`): its nodes by their tags, its inputs
 * among the references wired in, in rail order. Every node of the template the
 * board does not have yet is added, wired and @'d, and the template's mode,
 * model, params and prompts are written over the node and every generation it
 * reuses -- all through `placeTemplate`, the same placing an agent's proposal
 * goes through.
 * @param projectId - Project the canvas space belongs to.
 * @param spaceId - Canvas space containing the node.
 * @param nodeId - The panel's node.
 * @param models - Every model this deployment serves, across node types.
 * @param placeTemplate - Places the proposal around the nodes it reuses.
 * @returns The pick handler.
 */
export function useApplyTemplate(
  projectId: string,
  spaceId: string,
  nodeId: string,
  models: readonly ModelEntry[],
  placeTemplate: PlaceTemplate,
): (template: GenerationTemplate) => void {
  return React.useCallback(
    (template: GenerationTemplate) => {
      const byName = new Map(models.map((m) => [m.name, m]));
      if (!templateServed(template, new Set(byName.keys()))) {
        // The catalog refetched and dropped a model since the menu drew it.
        toast.error(t('canvas.generatePanel.modelUnavailable'));
        return;
      }
      const graph = readCanvasGraph(projectId, spaceId);
      const views = new Map(graph.nodes.map((n) => [n.id, n]));
      const own = views.get(nodeId);
      if (!own || !writable(own)) return;

      const rails = new Map(graph.nodes.map((n) => [n.id, deriveReferences(n.id, graph.nodes, graph.edges, new Map())]));
      const nodes = new Map<string, TemplateGraphNode>(
        graph.nodes.map((n): [string, TemplateGraphNode] => {
          const tag = n.type === 'group' || n.type === 'annotation' ? undefined : n.data.templateNode;
          const keyed = tag !== undefined && tag.key !== TEMPLATE_GUIDE_KEY;
          // Every node keeps the template's settings here: applying writes
          // each one it reuses back to them (inner#1345 6.5 step 3).
          return [n.id, { id: n.id, type: n.type as TemplateGraphNode['type'], ...(keyed ? { tag: { template: tag.template, key: tag.key } } : {}), keeps: true }];
        }),
      );
      const incoming = new Map([...rails].map(([id, rows]) => [id, rows.map((row) => ({ from: row.sourceNodeId }))]));
      const skeleton = templateSkeleton(template);
      const match = matchTemplateInstance(skeleton, { nodes, incoming }, nodeId);

      // The nodes the proposal starts from, at indices from 0: the panel's
      // node, then each template node the board already has, then each node
      // already given for an input.
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
        const view = views.get(id);
        if (view && !writable(view)) return;
        reuse.set(key, indexOf(id));
      }
      const inputs = new Map(
        [...match.inputs].map(([key, fed]) => [key, new Map([...fed].map(([at, id]) => [at, indexOf(id)]))]),
      );
      const wired = graph.edges.flatMap((edge) => {
        const fromIndex = held.indexOf(edge.source);
        const toIndex = held.indexOf(edge.target);
        return fromIndex >= 0 && toIndex >= 0 ? [{ fromIndex, toIndex }] : [];
      });
      const guided = graph.nodes.some((n) => {
        const tag = n.type === 'text' ? n.data.templateNode : undefined;
        return tag?.template === template.id && tag.key === TEMPLATE_GUIDE_KEY && tag.anchor === nodeId;
      });
      const expansion = expandTemplate(template, { anchorAt: 0, base: held.length, inputs, wired, reuse, guide: !guided });

      if (expansion.appended.length > 0 && inLockedGroup(own, views)) {
        toast.warning(t('canvas.template.groupLocked'));
        return;
      }

      const existing = new Map<number, ExistingNode>();
      const proposalNodes: ProposalNode[] = held.map((id, index) => {
        const view = views.get(id) as CanvasNodeView;
        const rewritten = expansion.rewritten.get(index);
        const fromTemplate = template.nodes.find((node) => node.role === 'generate' && reuse.get(node.key) === index)
          ?? (index === 0 ? template.nodes.find((node) => node.key === template.anchor) : undefined);
        const picked = fromTemplate?.role === 'generate' ? byName.get(fromTemplate.model) : undefined;
        const writes = fromTemplate?.role === 'generate' && picked ? templateWrites(fromTemplate, asContentView(view.data), picked) : undefined;
        existing.set(index, {
          nodeId: id,
          mention: mentionOf(id, view, rails),
          ...(writes === undefined ? {} : { paramsByModel: writes.paramsByModel }),
        });
        return rewritten ?? { role: 'source', type: view.type as ProposalNode['type'], name: nameOf(view) };
      });
      const proposal: CanvasProposal = {
        nodes: [...proposalNodes, ...expansion.appended],
        edges: expansion.edges,
        rationale: '',
      };
      try {
        placeTemplate(proposal, existing);
      } catch {
        toast.error(t('canvas.template.applyFailed'));
        return;
      }
      // An empty node to fill or words in braces to write are left for the
      // reader; nothing stops them generating as it is.
      const toFill =
        expansion.appended.some((node) => node.role === 'source' && node.resource === undefined) ||
        proposal.nodes.some((node) => proposalMarkSegments(node).some((segment) => segment.slot?.kind === 'tweak'));
      if (toFill) toast.info(t('canvas.generatePanel.editProposalMarks'));
    },
    [projectId, spaceId, nodeId, models, placeTemplate],
  );
}

/**
 * Whether a node may be written: a locked one shows the lock's warning.
 * @param view - The node.
 * @returns True when it may be written.
 */
function writable(view: CanvasNodeView): boolean {
  const block = evaluateNodeGate({ locked: view.data.locked === true });
  if (block === null) return true;
  warnNodeGate(t(block.toastKey));
  return false;
}

/**
 * Whether a node sits in a locked group, which takes no new members.
 * @param view - The node.
 * @param views - Every node by id.
 * @returns Whether it does.
 */
function inLockedGroup(view: CanvasNodeView, views: ReadonlyMap<string, CanvasNodeView>): boolean {
  const group = view.parentId === undefined ? undefined : views.get(view.parentId);
  return group?.type === 'group' && group.data.locked === true;
}

/**
 * A node's name as the canvas shows it.
 * @param view - The node.
 * @returns Its name.
 */
function nameOf(view: CanvasNodeView): string {
  return (view.data as { name?: string }).name ?? '';
}

/**
 * How a ref to a node already on the canvas is written: as the reference row
 * that shows it names and pictures it.
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
